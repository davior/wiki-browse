# WikiBrowse

A **client-side, zero-backend** single-page app that renders any MediaWiki as an
interactive [d3.js](https://d3js.org/) web of nodes. Give it a wiki's `api.php`
URL and a start page; click nodes to expand their linked neighbours and read the
page in a side panel. Nodes are colour-coded by their primary category.

Dark terminal/cyberpunk theme (Rajdhani / IBM Plex Mono / Share Tech Mono).

## Quick start

It's a static site — no build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(You can also open `index.html` via `file://`, but a local server avoids
some browser quirks with `DOMParser`/fetch.)

1. Click **⚙** → **ADD CONNECTION**.
2. Name it, set the **API URL** (must end in `api.php`), e.g.
   `https://en.wikipedia.org/w/api.php`.
3. Leave auth blank for public wikis. Click **SAVE**, then **USE**.
4. Type a start node (or leave blank for the wiki's Main Page) and hit **EXPLORE**.

## How it works

All API access funnels through `Api` (`js/api.js`) using the MediaWiki Action API:

- `generator=links` + `prop=categories|info` — expand a node's neighbours and read
  their primary category (for colour) in one request. Capped at 40 links/expansion
  to tame "hub explosion"; the API paginates the rest.
- `action=parse` — rendered HTML for the reader panel. Internal links are rewritten
  to expand/select nodes instead of leaving the app.
- `list=search` — start-node autocomplete.

## CORS — the one real constraint

A browser can only call a wiki that permits cross-origin requests.

- **Wikimedia wikis (Wikipedia, etc.)** allow anonymous reads via `origin=*` — they
  work out of the box, no backend.
- **Your own wiki**: add your app's origin to
  [`$wgCrossSiteAJAXdomains`](https://www.mediawiki.org/wiki/Manual:$wgCrossSiteAJAXdomains)
  in `LocalSettings.php`, e.g.
  ```php
  $wgCrossSiteAJAXdomains = [ 'localhost:8000', 'your-app.example' ];
  ```
- **Third-party wikis that block CORS**: you can't change their config. Set a
  **Proxy URL** on the connection (e.g. a small CORS proxy / Cloudflare Worker that
  forwards the request). It's prepended to every API call.

## Authentication (private wikis)

Read access to public wikis needs no credentials. For a **private** wiki:

1. Create a read-only **Bot Password** at `Special:BotPasswords` on the wiki
   (grant: *Basic rights* / read only).
2. Enter the bot username (`User@BotName`) and password in the connection form.
3. Your wiki must whitelist your app's origin in `$wgCrossSiteAJAXdomains` for
   authenticated cross-origin requests to succeed.

> ⚠ **Security:** the bot password is stored in this browser's `localStorage` and
> sent from client-side JS. Use a **read-only** grant, and click **FORGET** on a
> connection to wipe stored credentials. Don't use this for accounts with edit/admin
> rights.

## Project layout

```
index.html        markup + theme link
css/styles.css    theme (CSS variables, layout)
js/api.js         MediaWiki Action API wrapper (CORS/auth/proxy in one place)
js/categories.js  category → colour hashing + legend
js/graph.js       d3 force-directed graph (incremental add/expand)
js/app.js         glue: connections, start flow, reader panel, autocomplete
```

## Limitations

- The links API returns links **alphabetically, not by relevance**, so expansion
  shows the first N rather than the "most important" links.
- Article CSS isn't loaded from the wiki, so infoboxes/tables render plainly.
- Read-only: no editing.
