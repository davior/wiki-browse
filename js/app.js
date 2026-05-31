/* WikiBrowse — application glue: connections, start flow, reader panel, legend. */
const App = (() => {
  const LS_KEY = 'wikibrowse.connections.v1';
  let connections = [];
  let activeConnectionId = null;
  let locked = false;             // deployed config pins a single, read-only connection
  let defaultStartNode = null;    // locked-config start node to auto-explore on load (null = none)
  let currentTitle = null;        // page open in the reader
  let acItems = [];               // autocomplete state
  let acIndex = -1;
  let acTimer = null;

  /* ── persistence ── */
  function load() {
    const cfg = window.WIKIBROWSE_CONFIG || {};
    if (cfg.lockedConnection) {
      // Deployed configuration pins a single connection; ignore localStorage.
      // `startNode` (if present) is an app-level hint, not a connection field.
      const { startNode, ...connFields } = cfg.lockedConnection;
      locked = true;
      connections = [{ id: 'locked', ...connFields }];
      activeConnectionId = 'locked';
      defaultStartNode = startNode == null ? null : String(startNode);
      return;
    }
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      connections = raw.connections || [];
      activeConnectionId = raw.activeConnectionId || (connections[0] && connections[0].id) || null;
    } catch { connections = []; activeConnectionId = null; }
  }
  function save() {
    if (locked) return;           // never persist a deployed, locked connection
    localStorage.setItem(LS_KEY, JSON.stringify({ connections, activeConnectionId }));
  }
  function activeConn() { return connections.find(c => c.id === activeConnectionId) || null; }

  /* ── init ── */
  function init() {
    load();
    Graph.init(selectNode);
    renderActiveConn();
    wireAutocomplete();
    if (!connections.length) openConnectionsModal();
    document.getElementById('startInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && acIndex < 0) startExploration();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeConnectionsModal(); closeConnFormModal(); hideAutocomplete();
      }
    });
    // Auto-explore the deployed default node (blank string = the wiki's Main Page).
    if (defaultStartNode != null) {
      document.getElementById('startInput').value = defaultStartNode;
      startExploration();
    }
  }

  function renderActiveConn() {
    const conn = activeConn();
    const nameEl = document.getElementById('activeConnName');
    const urlEl = document.getElementById('activeConnUrl');
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    const connNameHdr = document.getElementById('connName');
    if (conn) {
      nameEl.textContent = conn.name;
      urlEl.textContent = conn.apiUrl + (Api.isAuthed(conn) ? '  · authed' : '');
      dot.className = 'status-dot connected';
      txt.textContent = 'READY';
      txt.style.color = 'var(--accent3)';
      connNameHdr.textContent = '· ' + conn.name.toUpperCase();
    } else {
      nameEl.textContent = 'No wiki connected';
      urlEl.textContent = 'Open ⚙ to add a connection';
      dot.className = 'status-dot';
      txt.textContent = 'NO CONNECTION';
      txt.style.color = 'var(--text3)';
      connNameHdr.textContent = '';
    }
  }

  /* ── exploration ── */
  async function startExploration() {
    const conn = activeConn();
    if (!conn) { toast('Add and select a wiki connection first', 'error'); openConnectionsModal(); return; }
    hideAutocomplete();
    let title = document.getElementById('startInput').value.trim();

    showLoading('CONNECTING…', conn.name);
    try {
      if (!title) {
        const info = await Api.getSiteInfo(conn);
        title = info.mainpage || 'Main Page';
      }
      Graph.clear();
      renderLegend();
      const start = Graph.addNode(title, { isStart: true });
      Graph.refresh();
      setLoadingText('EXPANDING…', title);
      await expandNode(title);
      selectNode(title, { skipExpandCheck: true, nav: 'reveal' });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      hideLoading();
    }
  }

  // Fetch neighbours of `title`, add nodes/links, recolour, refresh legend.
  async function expandNode(title) {
    const conn = activeConn();
    if (!conn) return;
    const res = await Api.getNeighbors(conn, title);
    // ensure the source node carries its own category too
    res.neighbors.forEach(nb => {
      Graph.addNode(nb.title, { primaryCategory: nb.primaryCategory, categories: nb.categories });
      Graph.addLink(title, nb.title);
    });
    Graph.markExpanded(title);
    Graph.refresh();
    renderLegend();
    if (res.cont) {
      toast(`Showing first ${res.neighbors.length} links of "${title}" (more available)`, 'info');
    }
  }

  /* ── node selection → reader ──
   * nav: 'cycle'   advance the node open → closed → unselected (graph clicks)
   *      'reveal'  force the node open and link it to `parent` (reader links, start)
   *      'none'    leave the node's state untouched
   * On a new selection the previously selected node, if open, demotes to closed.
   */
  async function selectNode(title, { skipExpandCheck = false, nav = 'cycle', parent = null } = {}) {
    const prev = currentTitle;
    currentTitle = title;
    if (nav !== 'none' && prev && prev !== title) Graph.demoteOpen(prev);
    if (nav === 'cycle') Graph.cycle(title);
    else if (nav === 'reveal') Graph.reveal(title, parent);
    Graph.setSelected(title);
    openReader();
    document.getElementById('readerTitle').textContent = title;
    document.getElementById('wikiContent').innerHTML =
      '<div class="legend-empty">Loading…</div>';
    const conn = activeConn();
    try {
      const page = await Api.parsePage(conn, title);
      document.getElementById('readerTitle').innerHTML = page.displayTitle;
      document.getElementById('readerCats').textContent =
        page.categories.length ? '▣ ' + page.categories.slice(0, 6).join(' · ') : '';
      renderContent(page.html, conn);
      const openBtn = document.getElementById('openWikiBtn');
      openBtn.href = pageUrl(conn, page.title);
      // auto-expand on first open of an unexpanded node
      if (!skipExpandCheck && !Graph.isExpanded(title)) await expandNode(title);
    } catch (e) {
      document.getElementById('wikiContent').innerHTML =
        `<div class="legend-empty">Could not load page: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function expandCurrent() {
    if (!currentTitle) return;
    showLoading('EXPANDING…', currentTitle);
    try { await expandNode(currentTitle); }
    catch (e) { toast(e.message, 'error'); }
    finally { hideLoading(); }
  }

  // Rewrite parsed wiki HTML: internal links become in-app node navigations,
  // images/anchors absolutised, edit/nav cruft already hidden via CSS.
  function renderContent(html, conn) {
    const container = document.getElementById('wikiContent');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = serverBase(conn);

    doc.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      const internal = parseInternalTitle(href, conn);
      if (internal) {
        a.classList.add('wb-internal');
        if (a.className.includes('new')) a.classList.add('wb-new');
        a.removeAttribute('href');
        a.dataset.title = internal;
      } else if (href.startsWith('//')) {
        a.setAttribute('href', 'https:' + href); a.target = '_blank'; a.rel = 'noopener';
      } else if (href.startsWith('/')) {
        a.setAttribute('href', base + href); a.target = '_blank'; a.rel = 'noopener';
      } else if (/^https?:/.test(href)) {
        a.target = '_blank'; a.rel = 'noopener';
      }
    });
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('//')) img.src = 'https:' + src;
      else if (src.startsWith('/')) img.src = base + src;
      img.removeAttribute('srcset');
    });

    container.innerHTML = doc.body.innerHTML;
    container.querySelectorAll('a.wb-internal').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        selectNode(a.dataset.title, { nav: 'reveal', parent: currentTitle });
      });
    });
  }

  /* ── URL helpers ── */
  function serverBase(conn) {
    try { const u = new URL(conn.apiUrl); return u.origin; } catch { return ''; }
  }
  function pageUrl(conn, title) {
    return serverBase(conn) + '/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  }
  // Returns the article title if href points to a same-wiki article, else null.
  function parseInternalTitle(href, conn) {
    if (!href || href.startsWith('#')) return null;
    let path;
    try {
      const u = new URL(href, conn.apiUrl);
      if (serverBase(conn) && u.origin !== serverBase(conn)) return null;
      path = u.pathname; var qTitle = u.searchParams.get('title');
    } catch { return null; }
    if (qTitle) return decodeURIComponent(qTitle).replace(/_/g, ' ');
    const m = path.match(/\/wiki\/(.+)$/);
    if (m) {
      const t = decodeURIComponent(m[1]).replace(/_/g, ' ');
      // skip non-article namespaces (File:, Help:, Special:, etc.) and section-only
      if (/^(File|Image|Special|Help|Category|Template|Talk|User|Wikipedia|Portal):/i.test(t)) return null;
      return t;
    }
    return null;
  }

  /* ── legend ── */
  function renderLegend() {
    const el = document.getElementById('legendList');
    const items = Categories.legend();
    if (!items.length) { el.innerHTML = '<div class="legend-empty">No categories yet</div>'; return; }
    el.innerHTML = items.slice(0, 40).map(it => `
      <div class="legend-item" title="${escapeHtml(it.category)}">
        <span class="legend-dot" style="border-color:${it.color}"></span>
        <span class="legend-label">${escapeHtml(it.category)}</span>
        <span class="legend-count">${it.count}</span>
      </div>`).join('');
  }

  /* ── reader open/close ── */
  function openReader() { document.getElementById('rightPanel').classList.remove('hidden'); }
  function closeReader() { document.getElementById('rightPanel').classList.add('hidden'); currentTitle = null; }

  function resetGraph() {
    Graph.clear();
    renderLegend();
    closeReader();
  }

  /* ── autocomplete for start node ── */
  function wireAutocomplete() {
    const input = document.getElementById('startInput');
    input.addEventListener('input', () => {
      clearTimeout(acTimer);
      const q = input.value.trim();
      if (q.length < 2 || !activeConn()) { hideAutocomplete(); return; }
      acTimer = setTimeout(async () => {
        try {
          acItems = await Api.search(activeConn(), q);
          renderAutocomplete();
        } catch { hideAutocomplete(); }
      }, 220);
    });
    input.addEventListener('keydown', e => {
      const box = document.getElementById('startAutocomplete');
      if (!box.firstChild) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); highlightAc(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = Math.max(acIndex - 1, -1); highlightAc(); }
      else if (e.key === 'Enter' && acIndex >= 0) { e.preventDefault(); chooseAc(acItems[acIndex]); }
      else if (e.key === 'Escape') hideAutocomplete();
    });
  }
  function renderAutocomplete() {
    const box = document.getElementById('startAutocomplete');
    acIndex = -1;
    if (!acItems.length) { hideAutocomplete(); return; }
    box.innerHTML = '<div class="autocomplete-list">' + acItems.map((t, i) =>
      `<div class="autocomplete-item" data-i="${i}">${escapeHtml(t)}</div>`).join('') + '</div>';
    box.querySelectorAll('.autocomplete-item').forEach(it =>
      it.addEventListener('click', () => chooseAc(acItems[+it.dataset.i])));
  }
  function highlightAc() {
    document.querySelectorAll('#startAutocomplete .autocomplete-item').forEach((el, i) =>
      el.classList.toggle('active', i === acIndex));
  }
  function chooseAc(title) {
    document.getElementById('startInput').value = title;
    hideAutocomplete();
    startExploration();
  }
  function hideAutocomplete() { document.getElementById('startAutocomplete').innerHTML = ''; acIndex = -1; }

  /* ── connections modal ── */
  function openConnectionsModal() { renderConnectionsModal(); document.getElementById('connectionsModal').classList.add('active'); }
  function closeConnectionsModal() { document.getElementById('connectionsModal').classList.remove('active'); }
  function renderConnectionsModal() {
    const body = document.getElementById('connectionsModalBody');
    const addBtn = document.getElementById('addConnectionBtn');
    if (addBtn) addBtn.style.display = locked ? 'none' : '';
    if (!connections.length) {
      body.innerHTML = '<div class="conn-empty">No connections yet. Add one below.</div>';
      return;
    }
    if (locked) {
      const c = connections[0];
      body.innerHTML = `<div class="conn-item active-conn">
        <div class="conn-dot active-conn"></div>
        <div style="flex:1;min-width:0">
          <div class="conn-name">${escapeHtml(c.name)}</div>
          <div class="conn-url">${escapeHtml(c.apiUrl)}</div>
          <div class="conn-auth">🔒 LOCKED · DEPLOYED CONFIGURATION</div>
        </div>
        <span style="font-size:9px;color:var(--accent3);font-family:'IBM Plex Mono',monospace">ACTIVE</span>
      </div>`;
      return;
    }
    body.innerHTML = connections.map(c => {
      const isActive = c.id === activeConnectionId;
      return `<div class="conn-item ${isActive ? 'active-conn' : ''}">
        <div class="conn-dot ${isActive ? 'active-conn' : ''}"></div>
        <div style="flex:1;min-width:0">
          <div class="conn-name">${escapeHtml(c.name)}</div>
          <div class="conn-url">${escapeHtml(c.apiUrl)}</div>
          ${Api.isAuthed(c) ? '<div class="conn-auth">🔑 BOT PASSWORD STORED</div>' : ''}
        </div>
        ${isActive ? '<span style="font-size:9px;color:var(--accent3);font-family:\'IBM Plex Mono\',monospace">ACTIVE</span>'
          : `<button class="step-btn step-btn-approve" onclick="App.activate('${c.id}')">USE</button>`}
        ${Api.isAuthed(c) ? `<button class="step-btn" onclick="App.forget('${c.id}')" title="Remove stored credentials">FORGET</button>` : ''}
        <button class="step-btn" onclick="App.edit('${c.id}')">EDIT</button>
        <button class="step-btn step-btn-reject" onclick="App.remove('${c.id}')">DEL</button>
      </div>`;
    }).join('');
  }
  function activate(id) { if (locked) return; activeConnectionId = id; save(); renderActiveConn(); renderConnectionsModal(); }
  function forget(id) {
    if (locked) return;
    const c = connections.find(x => x.id === id); if (!c) return;
    delete c.botPassword;
    Api.forgetSession(id);
    save(); renderConnectionsModal(); renderActiveConn();
    toast('Stored credentials removed', 'info');
  }
  function remove(id) {
    if (locked) return;
    if (!confirm('Delete this connection?')) return;
    connections = connections.filter(c => c.id !== id);
    if (activeConnectionId === id) activeConnectionId = connections[0] ? connections[0].id : null;
    Api.forgetSession(id);
    save(); renderConnectionsModal(); renderActiveConn();
  }

  /* ── connection form ── */
  function showAddConnectionForm() { if (locked) return; fillForm(null); document.getElementById('connFormModal').classList.add('active'); }
  function edit(id) { if (locked) return; fillForm(connections.find(c => c.id === id)); document.getElementById('connFormModal').classList.add('active'); }
  function closeConnFormModal() { document.getElementById('connFormModal').classList.remove('active'); }
  function fillForm(conn) {
    document.getElementById('connFormId').value = conn ? conn.id : '';
    document.getElementById('connFormName').value = conn ? conn.name : '';
    document.getElementById('connFormUrl').value = conn ? conn.apiUrl : '';
    document.getElementById('connFormUsername').value = conn ? (conn.botUsername || '') : '';
    document.getElementById('connFormPassword').value = '';
    document.getElementById('connFormProxy').value = conn ? (conn.proxyUrl || '') : '';
    document.getElementById('connFormTitle').textContent = conn ? '// EDIT CONNECTION' : '// ADD CONNECTION';
  }
  function saveConnection() {
    if (locked) return;
    const id = document.getElementById('connFormId').value;
    const name = document.getElementById('connFormName').value.trim();
    const apiUrl = document.getElementById('connFormUrl').value.trim();
    if (!name || !apiUrl) { toast('Name and API URL are required', 'error'); return; }
    if (!/api\.php/.test(apiUrl)) { toast('API URL should point to api.php', 'error'); return; }
    const botUsername = document.getElementById('connFormUsername').value.trim();
    const password = document.getElementById('connFormPassword').value;
    const proxyUrl = document.getElementById('connFormProxy').value.trim();

    if (id) {
      const c = connections.find(x => x.id === id);
      Object.assign(c, { name, apiUrl, botUsername, proxyUrl });
      if (password) c.botPassword = password;
      if (!botUsername) { delete c.botPassword; }
      Api.forgetSession(id);
    } else {
      const c = { id: 'c' + Date.now().toString(36), name, apiUrl, botUsername, proxyUrl };
      if (password) c.botPassword = password;
      connections.push(c);
      if (!activeConnectionId) activeConnectionId = c.id;
    }
    save();
    closeConnFormModal();
    renderConnectionsModal();
    renderActiveConn();
  }

  /* ── UI helpers ── */
  function showLoading(text, sub) {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingSub').textContent = sub || '';
    document.getElementById('loadingOverlay').classList.add('active');
  }
  function setLoadingText(text, sub) {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingSub').textContent = sub || '';
  }
  function hideLoading() { document.getElementById('loadingOverlay').classList.remove('active'); }
  function toast(msg, type = 'info') {
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    const dismiss = () => { el.style.animation = 'toastOut 0.2s ease forwards'; setTimeout(() => el.remove(), 200); };
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span class="toast-msg">${escapeHtml(msg)}</span>` +
      (type === 'error' ? '<button class="toast-close">×</button>' : '');
    document.getElementById('toastContainer').appendChild(el);
    if (type === 'error') el.querySelector('.toast-close').addEventListener('click', dismiss);
    else setTimeout(dismiss, 6000);
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return {
    init, startExploration, expandCurrent, resetGraph, closeReader,
    openConnectionsModal, closeConnectionsModal, showAddConnectionForm,
    closeConnFormModal, saveConnection, activate, edit, remove, forget,
  };
})();

window.addEventListener('DOMContentLoaded', App.init);
