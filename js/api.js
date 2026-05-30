/* WikiBrowse — MediaWiki Action API wrapper.
 *
 * Every network call funnels through wikiFetch() so the CORS / auth / proxy
 * strategy lives in exactly one place:
 *   - anonymous reads use origin=* (works on Wikimedia + any CORS-open wiki)
 *   - authenticated sessions (Bot Password) use an exact origin + credentials
 *   - an optional per-connection proxyUrl is prepended for CORS-blocked wikis
 */
const Api = (() => {
  // conn.id -> true once a Bot Password login has succeeded this session
  const loggedIn = new Set();
  // simple in-memory caches keyed by `${conn.id}|${title}`
  const neighborCache = new Map();
  const pageCache = new Map();

  function buildUrl(conn, params, authed) {
    const p = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    // Anonymous cross-origin requests use origin=*. Authenticated ones must send
    // the exact origin (and the wiki must whitelist it in $wgCrossSiteAJAXdomains).
    if (authed) {
      p.set('origin', window.location.origin === 'null' ? '' : window.location.origin);
    } else {
      p.set('origin', '*');
    }
    let url = conn.apiUrl + '?' + p.toString();
    if (conn.proxyUrl) url = conn.proxyUrl + encodeURIComponent(url);
    return url;
  }

  async function request(conn, params, { authed = false, method = 'GET', body = null } = {}) {
    const url = buildUrl(conn, params, authed);
    const opts = { method };
    // credentials must travel for authenticated sessions (session cookies)
    if (authed) opts.credentials = 'include';
    if (body) {
      opts.method = 'POST';
      opts.body = body;
    }
    let resp;
    try {
      resp = await fetch(url, opts);
    } catch (e) {
      throw new Error(
        'Network/CORS error. The wiki may not allow cross-origin requests — ' +
        'add a Proxy URL to this connection, or enable $wgCrossSiteAJAXdomains on the wiki.'
      );
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' from wiki API');
    const data = await resp.json();
    if (data.error) throw new Error(data.error.info || data.error.code || 'API error');
    return data;
  }

  // POST helper (login/token writes go via POST)
  function postBody(conn, params) {
    const fd = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    fd.set('origin', window.location.origin === 'null' ? '' : window.location.origin);
    return fd;
  }

  /* ── Auth: Bot Password login (two-step) ── */
  async function login(conn) {
    if (!conn.botUsername || !conn.botPassword) return false;
    if (loggedIn.has(conn.id)) return true;
    // 1) fetch a login token
    const tokRes = await request(conn, { action: 'query', meta: 'tokens', type: 'login' }, { authed: true });
    const lgtoken = tokRes.query.tokens.logintoken;
    // 2) submit credentials
    const data = await request(conn, {}, {
      authed: true,
      body: postBody(conn, {
        action: 'login',
        lgname: conn.botUsername,
        lgpassword: conn.botPassword,
        lgtoken,
      }),
    });
    if (data.login && data.login.result === 'Success') {
      loggedIn.add(conn.id);
      return true;
    }
    throw new Error('Login failed: ' + (data.login ? data.login.result : 'unknown'));
  }

  function isAuthed(conn) {
    return !!(conn.botUsername && conn.botPassword);
  }

  async function ensureSession(conn) {
    if (isAuthed(conn) && !loggedIn.has(conn.id)) await login(conn);
    return isAuthed(conn);
  }

  /* ── Reads ── */
  async function getSiteInfo(conn) {
    const authed = await ensureSession(conn);
    const data = await request(conn, {
      action: 'query', meta: 'siteinfo', siprop: 'general',
    }, { authed });
    return data.query.general; // has sitename, mainpage, base, server, articlepath
  }

  async function search(conn, query, limit = 8) {
    if (!query.trim()) return [];
    const authed = await ensureSession(conn);
    const data = await request(conn, {
      action: 'query', list: 'search', srsearch: query,
      srnamespace: '0', srlimit: String(limit), srprop: '',
    }, { authed });
    return (data.query.search || []).map(r => r.title);
  }

  /* Returns { title, neighbors: [{title, primaryCategory, categories[]}], cont } */
  async function getNeighbors(conn, title, contToken = null, limit = 40) {
    const cacheKey = conn.id + '|' + title + '|' + (contToken || '');
    if (neighborCache.has(cacheKey)) return neighborCache.get(cacheKey);

    const authed = await ensureSession(conn);
    const params = {
      action: 'query',
      generator: 'links',
      gpllimit: String(limit),
      gplnamespace: '0',
      titles: title,
      prop: 'categories|info',
      clshow: '!hidden',
      cllimit: 'max',
    };
    if (contToken) Object.assign(params, contToken);
    const data = await request(conn, params, { authed });

    const pages = (data.query && data.query.pages) || [];
    const neighbors = pages
      .filter(pg => !pg.missing)
      .map(pg => {
        const cats = (pg.categories || []).map(c => c.title.replace(/^Category:/, ''));
        return { title: pg.title, categories: cats, primaryCategory: cats[0] || null };
      });
    const result = { title, neighbors, cont: data.continue || null };
    neighborCache.set(cacheKey, result);
    return result;
  }

  /* Returns { title, displayTitle, html, categories[] } */
  async function parsePage(conn, title) {
    const cacheKey = conn.id + '|' + title;
    if (pageCache.has(cacheKey)) return pageCache.get(cacheKey);

    const authed = await ensureSession(conn);
    const data = await request(conn, {
      action: 'parse', page: title, prop: 'text|displaytitle|categories',
      redirects: '1', disablelimitreport: '1', disableeditsection: '1',
    }, { authed });
    const parse = data.parse;
    const result = {
      title: parse.title,
      displayTitle: parse.displaytitle || parse.title,
      html: parse.text,
      categories: (parse.categories || [])
        .filter(c => !c.hidden)
        .map(c => (c.category || c['*'] || '').replace(/_/g, ' ')),
    };
    pageCache.set(cacheKey, result);
    return result;
  }

  function forgetSession(connId) {
    loggedIn.delete(connId);
    for (const k of [...neighborCache.keys()]) if (k.startsWith(connId + '|')) neighborCache.delete(k);
    for (const k of [...pageCache.keys()]) if (k.startsWith(connId + '|')) pageCache.delete(k);
  }

  return { login, isAuthed, getSiteInfo, search, getNeighbors, parsePage, forgetSession };
})();
