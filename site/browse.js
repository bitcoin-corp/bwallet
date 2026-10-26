/**
 * www.bwallet.space/browse?url=<https url>: shown when the link did NOT open the bWallet app (not installed, or
 * iOS ignored it). Offers: continue to the page in this browser, try the app again (bwalletx://browse?url=…, or an
 * Android intent falling back to /get), and Get bWallet. Only https targets; the host is shown plainly, and nothing
 * redirects without a tap, so this page can't be used to bounce people somewhere silently.
 */
(function () {
  var GET = 'https://www.bwallet.space/get';

  function target(search) {
    try {
      var raw = new URLSearchParams(search).get('url');
      if (!raw || raw.length > 2048) return null;
      var t = new URL(raw);
      if (t.protocol !== 'https:' || t.username || t.password || !t.hostname) return null;
      return t.toString();
    } catch (e) {
      return null;
    }
  }

  function links(search, ua) {
    var t = target(search);
    if (!t) return null;
    var q = 'url=' + encodeURIComponent(t);
    var app = /Android/i.test(ua)
      ? 'intent://browse?' + q + '#Intent;scheme=bwalletx;S.browser_fallback_url=' + encodeURIComponent(t) + ';end'
      : 'bwalletx://browse?' + q;
    return { target: t, host: new URL(t).host, app: app, get: GET };
  }

  var api = { target: target, links: links };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  var l = links(location.search, navigator.userAgent);
  document.documentElement.setAttribute('data-state', l ? 'ok' : 'bad');
  if (!l) return;
  document.getElementById('host').textContent = l.host;
  document.getElementById('go').href = l.target;
  document.getElementById('go-host').textContent = l.host;
  document.getElementById('open-app').href = l.app;
  document.getElementById('get-app').href = l.get;
})();
