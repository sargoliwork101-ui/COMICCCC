// Presentation only: closing a report never cancels a job or revokes its download URL.
(() => {
  'use strict';
  const dialog = document.getElementById('resultDialog');
  let previousFocus;
  window.openResultDialog = () => {
    if (dialog.open) return;
    previousFocus = document.activeElement;
    dialog.showModal();
    document.getElementById('closeResultDialog').focus();
  };
  const close = () => {
    dialog.close();
    if (previousFocus?.isConnected && !previousFocus.disabled && previousFocus.getClientRects().length) previousFocus.focus();
    else document.querySelector('#outputSettings>summary').focus();
  };
  document.getElementById('closeResultDialog').onclick = close;
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  // Consume Escape before the viewer's global cancellation shortcuts.
  window.addEventListener('keydown', e => {
    if (dialog.open && e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); close();
    }
  }, true);
})();
