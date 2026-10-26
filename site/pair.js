/**
 * www.bwallet.space/pair: the page people see when a pairing link did NOT open the bWallet app.
 *
 * On a phone it never mentions "your computer" and never shows a QR. It offers:
 *   1. Open in the bWallet app  (iOS: bwalletx://pair?…, because iOS ignores a universal link tapped on its own
 *      domain; Android: intent://pair?…;scheme=bwalletx with /get as the fallback when the app isn't installed)
 *   2. Use the web wallet       (web.bwalletx.com/m/settings?bwxpair=1&<the same params>: same request, same return)
 *   3. Get bWallet              (/get, which picks the store)
 * The pairing params are passed through untouched; the wallet checks them in full (src/pair/protocol.ts).
 */
(function (root) {
  var WEB_WALLET = 'https://web.bwalletx.com/m/settings';
  var GET = 'https://www.bwallet.space/get';

  function phoneKind(ua, maxTouchPoints) {
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios'; // iPadOS reports a Mac
    return null;
  }

  /** Only the known pairing params, so nothing else rides along into the app or the web wallet. */
  var PARAMS = ['v', 'r', 'c', 'k', 'o', 'e', 's', 'ret', 'rid', 'b', 's2'];
  function pairQuery(search) {
    var src = new URLSearchParams(search);
    var out = new URLSearchParams();
    PARAMS.forEach(function (k) {
      var v = src.get(k);
      if (v !== null) out.set(k, v);
    });
    return out.toString();
  }

  function links(search, kind) {
    var q = pairQuery(search);
    if (!q) return null;
    var app =
      kind === 'android'
        ? 'intent://pair?' + q + '#Intent;scheme=bwalletx;S.browser_fallback_url=' + encodeURIComponent(GET) + ';end'
        : 'bwalletx://pair?' + q;
    return { app: app, web: WEB_WALLET + '?bwxpair=1&' + q, get: GET };
  }

  var api = { phoneKind: phoneKind, pairQuery: pairQuery, links: links };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document === 'undefined') return;
  var kind = phoneKind(navigator.userAgent, navigator.maxTouchPoints || 0);
  var l = links(location.search, kind);
  // The page stays hidden until this runs, so a phone never flashes the desktop copy.
  document.documentElement.setAttribute('data-kind', kind || 'desktop');
  if (!kind || !l) return;
  document.getElementById('open-app').href = l.app;
  document.getElementById('open-web').href = l.web;
  document.getElementById('get-app').href = l.get;
  try {
    var host = new URL(new URLSearchParams(location.search).get('o') || '').host;
    if (host) document.getElementById('site-host').textContent = host;
  } catch (e) {
    /* no origin: keep "the website" */
  }
})(this);
