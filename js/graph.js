/* WikiBrowse — d3 force-directed graph.
 *
 * Pattern adapted from the user's WikiGen reference (initGraph/renderGraph):
 * grid background, link+node layers, forceSimulation with link/charge/center/
 * collide, drag + zoom. Unlike the reference this maintains state incrementally
 * (addNode / addLink) so expanding a node merges into the existing web rather
 * than redrawing from scratch.
 */
const Graph = (() => {
  let svg, linkLayer, nodeLayer, zoomBehavior, simulation;
  let width = 800, height = 600;
  let onNodeClick = () => {};

  const nodeMap = new Map();   // title -> node {id,title,primaryCategory,expanded,open,...}
  const linkSet = new Set();   // "a|b" dedupe key
  let links = [];
  const adj = new Map();       // title -> Set of neighbour titles (d3-independent)

  // Open/closed navigation: every node has an `open` flag. Visibility radiates
  // out from the start node — an OPEN node shows all its neighbours, a CLOSED
  // node shows only the neighbours that are themselves open. `visibleSet` caches
  // the most recent computation for hit-testing in refresh().
  let visibleSet = new Set();

  function init(clickHandler) {
    onNodeClick = clickHandler || onNodeClick;
    const panel = document.getElementById('graphPanel');
    const rect = panel.getBoundingClientRect();
    width = rect.width || 800;
    height = rect.height || 600;

    svg = d3.select('#graph').attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();

    const defs = svg.append('defs');
    const pattern = defs.append('pattern').attr('id', 'grid')
      .attr('width', 40).attr('height', 40).attr('patternUnits', 'userSpaceOnUse');
    pattern.append('path').attr('d', 'M 40 0 L 0 0 0 40')
      .attr('fill', 'none').attr('stroke', '#1a2030').attr('stroke-width', '0.5');
    svg.append('rect').attr('width', width).attr('height', height).attr('fill', 'url(#grid)');

    linkLayer = svg.append('g').attr('class', 'links');
    nodeLayer = svg.append('g').attr('class', 'nodes');

    zoomBehavior = d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => {
      linkLayer.attr('transform', e.transform);
      nodeLayer.attr('transform', e.transform);
    });
    svg.call(zoomBehavior);

    simulation = d3.forceSimulation([])
      .force('link', d3.forceLink([]).id(d => d.id).distance(130))
      .force('charge', d3.forceManyBody().strength(-280))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(40))
      .on('tick', tick);

    window.addEventListener('resize', onResize);
  }

  function onResize() {
    const rect = document.getElementById('graphPanel').getBoundingClientRect();
    if (!rect.width) return;
    width = rect.width; height = rect.height;
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.alpha(0.3).restart();
  }

  function clear() {
    nodeMap.clear();
    linkSet.clear();
    links = [];
    adj.clear();
    visibleSet = new Set();
    Categories.reset();
    if (nodeLayer) nodeLayer.selectAll('*').remove();
    if (linkLayer) linkLayer.selectAll('*').remove();
    if (simulation) { simulation.nodes([]); simulation.force('link').links([]); }
    updateInfo();
  }

  // Adds a node if new; returns the node object. seedXY anchors it near centre.
  function addNode(title, { primaryCategory = null, categories = [], isStart = false } = {}) {
    if (nodeMap.has(title)) {
      const n = nodeMap.get(title);
      if (primaryCategory && !n.primaryCategory) {
        n.primaryCategory = primaryCategory;
        n.categories = categories;
        Categories.untrack(null);
        Categories.track(primaryCategory);
      }
      return n;
    }
    const n = {
      id: title, title,
      primaryCategory, categories,
      expanded: false, isStart,
      // Tri-state cycled on click: 'open' → 'closed' → 'unselected' → 'open'.
      // Start node opens by default; newly discovered nodes start unselected.
      state: isStart ? 'open' : 'unselected',
      x: width / 2 + (Math.random() - 0.5) * 120,
      y: height / 2 + (Math.random() - 0.5) * 120,
    };
    nodeMap.set(title, n);
    Categories.track(primaryCategory);
    return n;
  }

  function addLink(sourceTitle, targetTitle) {
    if (sourceTitle === targetTitle) return;
    const key = [sourceTitle, targetTitle].sort().join('|');
    if (linkSet.has(key)) return;
    if (!nodeMap.has(sourceTitle) || !nodeMap.has(targetTitle)) return;
    linkSet.add(key);
    links.push({ source: sourceTitle, target: targetTitle });
    if (!adj.has(sourceTitle)) adj.set(sourceTitle, new Set());
    if (!adj.has(targetTitle)) adj.set(targetTitle, new Set());
    adj.get(sourceTitle).add(targetTitle);
    adj.get(targetTitle).add(sourceTitle);
  }

  /* ── open / closed / unselected navigation ── */

  const STATES = ['open', 'closed', 'unselected'];
  function rank(state) { return state === 'open' ? 2 : state === 'closed' ? 1 : 0; }

  // Recompute which nodes are visible, radiating out from the start node.
  // An edge Y—X reveals X (given Y is already visible) when Y is open (an open
  // node shows ALL its neighbours) or X is open/closed (a closed or unselected
  // node still shows the open/closed nodes linked to it — but not unselected
  // ones). With no start node yet, everything is shown — covers the transient
  // expand-before-select during a fresh exploration.
  function computeVisible() {
    const vis = new Set();
    const start = [...nodeMap.values()].find(n => n.isStart);
    if (!start) { nodeMap.forEach(n => vis.add(n.title)); return vis; }
    vis.add(start.title);
    let changed = true;
    while (changed) {
      changed = false;
      for (const y of [...vis]) {
        const yOpen = nodeMap.get(y).state === 'open';
        const ns = adj.get(y);
        if (!ns) continue;
        for (const x of ns) {
          if (vis.has(x)) continue;
          const xs = (nodeMap.get(x) || {}).state;
          if (yOpen || xs === 'open' || xs === 'closed') { vis.add(x); changed = true; }
        }
      }
    }
    return vis;
  }

  function isVisibleNode(title) { return visibleSet.has(title); }

  // Advance a node through open → closed → unselected → open, then redraw.
  function cycle(title) {
    const n = nodeMap.get(title);
    if (!n) return;
    n.state = STATES[(STATES.indexOf(n.state) + 1) % STATES.length];
    refresh();
  }

  // Demote an open node to closed without redrawing (caller refreshes). Used for
  // the previously selected node when a new node is selected; non-open is left as-is.
  function demoteOpen(title) {
    const n = nodeMap.get(title);
    if (n && n.state === 'open') n.state = 'closed';
  }

  // Ensure a node exists, is linked to `parent`, and is open/visible. Used for
  // programmatic navigation (e.g. following an internal link in the reader).
  function reveal(title, parent) {
    if (!nodeMap.has(title)) addNode(title);
    if (parent && nodeMap.has(parent)) addLink(parent, title);
    nodeMap.get(title).state = 'open';
    refresh();
  }

  function markExpanded(title) {
    const n = nodeMap.get(title);
    if (n) n.expanded = true;
  }

  function hasNode(title) { return nodeMap.has(title); }
  function isExpanded(title) { return !!(nodeMap.get(title) || {}).expanded; }

  // Re-bind selections to current data and restart the simulation.
  function refresh() {
    visibleSet = computeVisible();
    const nodes = [...nodeMap.values()].filter(n => isVisibleNode(n.title));
    const visLinks = links.filter(l => {
      const s = l.source.id || l.source, t = l.target.id || l.target;
      return isVisibleNode(s) && isVisibleNode(t);
    });
    document.getElementById('graphEmpty').style.display = nodes.length ? 'none' : 'block';

    const linkSel = linkLayer.selectAll('line.link')
      .data(visLinks, d => [d.source.id || d.source, d.target.id || d.target].sort().join('|'));
    linkSel.exit().remove();
    linkSel.enter().append('line').attr('class', 'link');
    // Edge styling follows its weakest endpoint (open > closed > unselected).
    linkLayer.selectAll('line.link').attr('class', d => 'link ' + linkLevel(d));

    const nodeSel = nodeLayer.selectAll('g.node').data(nodes, d => d.id);
    nodeSel.exit().remove();
    const enter = nodeSel.enter().append('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on('click', (e, d) => { e.stopPropagation(); onNodeClick(d.title); });
    enter.append('circle');
    enter.append('text').attr('dy', 26).attr('text-anchor', 'middle');

    const merged = enter.merge(nodeSel);
    merged.attr('class', d => nodeClass(d));
    merged.select('circle')
      .attr('r', d => d.isStart ? 16 : 12)
      .attr('fill', d => Categories.fillFor(d.primaryCategory))
      .attr('stroke', d => Categories.colorFor(d.primaryCategory));
    merged.select('text')
      .style('font-size', d => d.isStart ? '11px' : '9px')
      .text(d => d.title.length > 18 ? d.title.slice(0, 16) + '…' : d.title);

    simulation.nodes(nodes);
    simulation.force('link').links(visLinks);
    simulation.alpha(0.6).restart();
    updateInfo(nodes.length, visLinks.length);
  }

  function nodeClass(d) {
    return 'node state-' + d.state
      + (d.expanded ? ' expanded' : ' collapsed')
      + (d.selected ? ' selected' : '');
  }

  // Class for a link based on the weakest (least open) of its two endpoints.
  function linkLevel(d) {
    const s = nodeMap.get(d.source.id || d.source) || {};
    const t = nodeMap.get(d.target.id || d.target) || {};
    const m = Math.min(rank(s.state), rank(t.state));
    return m === 2 ? 'lvl-open' : m === 1 ? 'lvl-closed' : 'lvl-unselected';
  }

  function setSelected(title) {
    nodeMap.forEach(n => { n.selected = (n.title === title); });
    nodeLayer.selectAll('g.node').attr('class', d => nodeClass(d));
  }

  function tick() {
    linkLayer.selectAll('line.link')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeLayer.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`);
  }

  function updateInfo(n = nodeMap.size, l = links.length) {
    document.getElementById('nodeCount').textContent = n;
    document.getElementById('linkCount').textContent = l;
    document.getElementById('graphInfo').textContent = n
      ? `${n} NODES · ${l} LINKS · DRAG · SCROLL TO ZOOM · CLICK TO OPEN`
      : '';
  }

  return {
    init, clear, addNode, addLink, markExpanded, hasNode, isExpanded,
    refresh, setSelected, cycle, demoteOpen, reveal,
  };
})();
