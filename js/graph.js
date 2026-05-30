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

  const nodeMap = new Map();   // title -> node {id,title,primaryCategory,expanded,...}
  const linkSet = new Set();   // "a|b" dedupe key
  let links = [];
  const adj = new Map();       // title -> Set of neighbour titles (d3-independent)

  // Focus-path navigation: only the breadcrumb path (root → … → focus) plus the
  // focused node's own links are shown. `focusOpen` toggles the focused node's children.
  let path = [];               // ordered titles, root → … → focus
  let focusOpen = true;

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
    path = [];
    focusOpen = true;
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

  /* ── focus-path navigation ── */
  function focusTitle() { return path.length ? path[path.length - 1] : null; }

  // A node is visible when it is on the breadcrumb path, or it is a child of the
  // focused node while that node is open. Before any selection (path empty) we
  // show everything — covers the transient expand-before-select on a fresh start.
  function isVisibleNode(title) {
    if (!path.length) return true;
    if (path.includes(title)) return true;
    const f = focusTitle();
    if (focusOpen && f && adj.has(f) && adj.get(f).has(title)) return true;
    return false;
  }

  // Update the path/focus state in response to a node selection, then redraw.
  function navigateTo(title) {
    if (!nodeMap.has(title)) addNode(title);
    const prev = focusTitle();
    if (title === prev) {
      focusOpen = !focusOpen;            // re-click focus → collapse/expand its children
    } else if (path.includes(title)) {
      path = path.slice(0, path.indexOf(title) + 1);  // ancestor → truncate path to it
      focusOpen = true;
    } else {
      if (prev) addLink(prev, title);    // keep the path connected even for reader-link jumps
      path.push(title);
      focusOpen = true;
    }
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
    return 'node' + (d.expanded ? ' expanded' : ' collapsed')
      + (d.selected ? ' selected' : '')
      + (path.includes(d.title) ? ' on-path' : '');
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
    refresh, setSelected, navigateTo,
  };
})();
