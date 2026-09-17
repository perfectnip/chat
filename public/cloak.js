/* Tab cloak — same feature as the main site (perfectnip.github.io).
 * Applies on every load unless disabled, and exposes window.JchatCloak so
 * the Settings page can update title/icon live without a reload. */
(function () {
  'use strict';
  var CLOAK_ICONS = [
    { name: 'Default', src: '/cloak-images/default.png' },
    { name: 'Docs', src: '/cloak-images/docs.png' },
    { name: 'Sheets', src: '/cloak-images/sheets.png' },
    { name: 'Drive', src: '/cloak-images/drive.png' },
    { name: 'Forms', src: '/cloak-images/forms.png' },
    { name: 'Gmail', src: '/cloak-images/gmail.png' },
    { name: 'Google', src: '/cloak-images/google.png' },
    { name: 'PAUSD', src: '/cloak-images/pausd.png' },
    { name: 'Schoology', src: '/cloak-images/schoology.png' },
  ];
  var DEFAULT_TITLE = 'Inbox - Gmail';
  var DEFAULT_ICON = '/cloak-images/gmail.png';

  function toFav(u) {
    if (!u || u.indexOf('data:') === 0) return u;
    var m = u.match(/^(\/?cloak-images\/)([^/]+)\.png$/);
    return m ? m[1] + 'favicon/' + m[2] + '.ico' : u;
  }
  function favType(u) {
    if (!u) return '';
    if (u.indexOf('data:image/') === 0) return u.slice(5, u.indexOf(';'));
    if (/\.ico(\?|#|$)/i.test(u)) return 'image/x-icon';
    if (/\.png(\?|#|$)/i.test(u)) return 'image/png';
    if (/\.svg(\?|#|$)/i.test(u)) return 'image/svg+xml';
    return '';
  }
  function read() {
    var enabled = localStorage.getItem('jchatCloak') === 'true';
    var title = localStorage.getItem('jchatCloakTitle') || DEFAULT_TITLE;
    var icon = localStorage.getItem('jchatCloakIcon') || DEFAULT_ICON;
    return { enabled: enabled, title: title, icon: icon };
  }
  function apply(conf) {
    var c = conf || read();
    if (!c.enabled) return false;
    document.title = c.title;
    var fav = toFav(c.icon);
    var ft = favType(fav);
    var links = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
    links.forEach(function (l) {
      l.href = fav;
      if (ft) l.type = ft; else l.removeAttribute('type');
    });
    return true;
  }
  window.JchatCloak = { icons: CLOAK_ICONS, defaults: { title: DEFAULT_TITLE, icon: DEFAULT_ICON }, read: read, apply: apply };
  try { apply(); } catch (_) { /* localStorage blocked (private mode) — leave defaults */ }
})();
