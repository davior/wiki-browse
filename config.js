/* WikiBrowse — deploy-time configuration.
 *
 * This file is loaded (via a <script> tag in index.html) before the app boots.
 * Edit it when deploying to pin the app to a single wiki.
 *
 * Leave `lockedConnection` as null for the normal multi-connection experience
 * (users add/edit/switch wikis themselves, stored in localStorage).
 *
 * Set `lockedConnection` to force a single connection: the app boots straight
 * into that wiki and the connection-management UI becomes read-only — no
 * adding, editing, deleting, or switching, and nothing is persisted to
 * localStorage. See config.example.js for an annotated sample.
 */
window.WIKIBROWSE_CONFIG = {
  lockedConnection: null,
};
