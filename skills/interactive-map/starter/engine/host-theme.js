// map-pack engine: a host's theme from the page's first frame. Kit-owned file, loaded as a plain script at the top of
// index.html, so it runs before the page draws anything; engine/host.js does everything else once the modules run.
// The engine's modules run after the page's first frames, so a host's frame reloaded in a dark host on a light device
// (Studio's Reload) showed the light page until then. A frame that showed this page before at this address in this tab
// keeps the host's last layout (host.js stashes it per path, and the browser per address): its theme goes on <html>
// now. That is a reload of the same frame (Studio's Reload button); Studio opens a site at a new address each time
// (a card press, a reload of Studio), where nothing is kept yet, so those wait for the host's layout message, as before.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    var host = q.get('instafy_host') || q.get('uw_host');
    if (!host || !/^[a-z][a-z0-9_-]{0,31}$/.test(host)) return;
    var raw = sessionStorage.getItem('uw:host-layout:' + (location.pathname || '/'));
    var theme = raw ? JSON.parse(raw).theme : null;
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-uw-host-theme', theme);
  } catch (e) { /* storage off: the host's layout message sets it */ }
})();
