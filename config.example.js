/* WikiBrowse — example deployment configuration.
 *
 * Copy this file to `config.js` and edit the values to pin a deployment to a
 * single wiki. When `lockedConnection` is set:
 *   - the app boots straight into the configured wiki,
 *   - the ⚙ connections panel is read-only (no add / edit / delete / switch),
 *   - nothing is written to localStorage.
 *
 * Leave `lockedConnection: null` for the default behaviour where users manage
 * their own connections.
 */
window.WIKIBROWSE_CONFIG = {
  lockedConnection: {
    name: 'My Wiki',
    apiUrl: 'https://wiki.example.com/w/api.php', // must point to api.php
    proxyUrl: '',     // optional — set only if the wiki blocks cross-origin calls
    botUsername: '',  // optional — for private wikis (Special:BotPasswords, read-only grant)
    botPassword: '',  // optional — paired with botUsername
    startNode: '',    // optional — auto-explore this page on load ('' = the wiki's Main Page).
                      // Omit the key entirely to start with an empty graph.
  },
};
