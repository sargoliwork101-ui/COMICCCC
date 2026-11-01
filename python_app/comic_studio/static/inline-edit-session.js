/* Transactional state for direct-on-image editing. No UI or rendering dependencies. */
(function (root) {
  'use strict';

  function createInlineEditSession({ block, mode, read, getBaseline, snapshot, onCommit, onConflict }) {
    if (!block || !['ocr', 'translation'].includes(mode) || typeof read !== 'function' || typeof snapshot !== 'function') {
      throw new TypeError('Invalid inline edit session configuration');
    }
    let closed = false;
    let conflictReported = false;

    function candidate() {
      const value = read();
      const next = { ...block };
      if (mode === 'ocr') next.text = String(value.text ?? '');
      else {
        next.tr = String(value.text ?? '');
        next.richHtml = String(value.richHtml ?? '');
        if (value.dir === 'rtl' || value.dir === 'ltr') next.dir = value.dir;
      }
      if (['left', 'right', 'center', 'justify'].includes(value.align)) next.align = value.align;
      if (['top', 'middle', 'bottom'].includes(value.verticalAlign)) next.verticalAlign = value.verticalAlign;
      if (value.size === null || (Number.isFinite(value.size) && value.size >= 8 && value.size <= 160)) {
        next.size = value.size === null ? null : Math.round(value.size);
      }
      if (value.color === null || /^#[0-9a-f]{6}$/i.test(value.color || '')) next.color = value.color;
      return next;
    }

    function previewBlock() { return closed ? null : candidate(); }

    function commit() {
      if (closed) return false;
      const baseline = getBaseline?.();
      if (baseline != null && snapshot(block) !== baseline) {
        if (!conflictReported) onConflict?.(block);
        conflictReported = true;
        return false;
      }
      const next = candidate();
      const changed = snapshot(next) !== snapshot(block);
      if (changed) {
        // Only assign editable properties; geometry and unrelated fields may have changed independently.
        if (mode === 'ocr') block.text = next.text;
        else { block.tr = next.tr; block.richHtml = next.richHtml; if ('dir' in next) block.dir = next.dir; }
        block.align = next.align; block.verticalAlign = next.verticalAlign; block.size = next.size; block.color = next.color;
        conflictReported = false;
        onCommit?.(block, snapshot(block));
      }
      return true;
    }

    function close({ discardConflict = false } = {}) {
      if (closed) return true;
      const committed = commit();
      if (!committed && !discardConflict) return false;
      closed = true;
      return committed;
    }

    return Object.freeze({ previewBlock, commit, close, isClosed: () => closed,
      isDirty: () => !closed && snapshot(candidate()) !== snapshot(block) });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createInlineEditSession };
  root.createInlineEditSession = createInlineEditSession;
})(typeof window !== 'undefined' ? window : globalThis);
