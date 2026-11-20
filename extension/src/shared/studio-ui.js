/* global chrome */
// Local presentation preference only; no document text or keys are read here.
(() => {
  'use strict';
  const key = 'hasaya_ui_theme';
  const root = document.documentElement;
  const host = document.querySelector('.topbar-side') || document.querySelector('.settings-heading') || document.querySelector('.import-header') || document.querySelector('.brand');
  if (!host) return;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'studio-theme-toggle'; button.id = 'studioThemeToggle';
  button.innerHTML = '<svg class="studio-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>';
  host.appendChild(button);
  if (!location.pathname.includes('/help/')) {
    const help = document.createElement('a');
    help.className = 'studio-theme-toggle studio-guide-link';
    help.href = '../help/help.html'; help.target = '_blank'; help.rel = 'noopener';
    help.title = 'راهنمای افزونه'; help.setAttribute('aria-label', help.title);
    help.innerHTML = '<svg class="studio-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5m0 3h.01"/></svg>';
    host.appendChild(help);
  }
  let interacted = false;
  const apply = (theme) => {
    root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    button.title = root.dataset.theme === 'light' ? 'فعال‌کردن تم تیره' : 'فعال‌کردن تم روشن';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(root.dataset.theme === 'light'));
  };
  apply(window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  try {
    Promise.resolve(chrome.storage.local.get([key])).then((saved) => {
      if (!interacted && ['light', 'dark'].includes(saved?.[key])) apply(saved[key]);
    }).catch(() => {});
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && ['light', 'dark'].includes(changes[key]?.newValue)) apply(changes[key].newValue);
    });
  } catch { /* storage can be unavailable; the toggle still works in this tab */ }
  button.addEventListener('click', () => {
    interacted = true;
    apply(root.dataset.theme === 'light' ? 'dark' : 'light');
    try { Promise.resolve(chrome.storage.local.set({ [key]: root.dataset.theme })).catch(() => {}); } catch { /* visual preference only */ }
  });
})();
