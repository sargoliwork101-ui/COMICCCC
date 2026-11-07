/* Shared, DOM-independent grouping rules for the grid and its regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StudioGroups = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const validId = (value) => value !== null && value !== undefined && String(value).trim() !== '';
  const idKey = (value) => String(value);
  const byOrder = (images) => [...images].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

  function replace(images, ordered) {
    images.splice(0, images.length, ...ordered);
    images.forEach((item, index) => { item.order = index; });
    return images;
  }

  function groupMap(images) {
    const map = new Map();
    byOrder(images).forEach((item) => {
      if (!validId(item.groupId)) return;
      const key = idKey(item.groupId);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    for (const [key, members] of map) if (members.length < 2) map.delete(key);
    return map;
  }

  function cleanup(images) {
    const valid = groupMap(images);
    byOrder(images).forEach((item) => {
      if (validId(item.groupId) && !valid.has(idKey(item.groupId))) item.groupId = null;
    });
    return replace(images, byOrder(images));
  }

  function normalizeIds(images) {
    const used = new Set();
    byOrder(images).forEach((item) => {
      const value = Number(item.groupId);
      if (Number.isInteger(value) && value > 0) used.add(value);
    });
    let next = 1;
    const legacy = new Map();
    byOrder(images).forEach((item) => {
      if (!validId(item.groupId)) { item.groupId = null; return; }
      const numeric = Number(item.groupId);
      if (Number.isInteger(numeric) && numeric > 0) { item.groupId = numeric; return; }
      const old = idKey(item.groupId);
      if (!legacy.has(old)) {
        while (used.has(next)) next += 1;
        legacy.set(old, next); used.add(next);
      }
      item.groupId = legacy.get(old);
    });
    return cleanup(images);
  }

  function normalizeLayout(images) {
    normalizeIds(images);
    const groups = groupMap(images);
    const emitted = new Set();
    const result = [];
    byOrder(images).forEach((item) => {
      const key = validId(item.groupId) ? idKey(item.groupId) : null;
      if (!key || !groups.has(key)) { result.push(item); return; }
      if (emitted.has(key)) return;
      emitted.add(key);
      result.push(...groups.get(key));
    });
    return replace(images, result);
  }

  function nextId(images) {
    return Math.max(0, ...images.map((item) => Number(item.groupId) || 0)) + 1;
  }

  function create(images, selectedIds) {
    const ids = new Set(selectedIds);
    const selected = byOrder(images).filter((item) => ids.has(item.id));
    if (selected.length < 2) return null;
    const existing = selected.map((item) => Number(item.groupId) || 0).filter((value) => value > 0);
    const groupId = existing.length ? Math.min(...existing) : nextId(images);
    selected.forEach((item) => { item.groupId = groupId; });
    normalizeLayout(images);
    return groupId;
  }

  function dropToGroup(images, draggedIds, targetId) {
    const dragged = byOrder(images).filter((item) => draggedIds.includes(item.id));
    const target = images.find((item) => item.id === targetId);
    if (!target || !dragged.length || dragged.some((item) => item.id === targetId)) return null;
    const oldTarget = validId(target.groupId) ? idKey(target.groupId) : null;
    const oldDrag = validId(dragged[0].groupId) ? idKey(dragged[0].groupId) : null;
    if (oldTarget && oldDrag && oldTarget === oldDrag) return null;
    const targetNumber = Number(target.groupId) || 0;
    const dragNumber = Number(dragged[0].groupId) || 0;
    const groupId = targetNumber || dragNumber || nextId(images);
    target.groupId = groupId;
    dragged.forEach((item) => { item.groupId = groupId; });
    normalizeLayout(images);
    return groupId;
  }

  function removeGroup(images, groupId) {
    const key = idKey(groupId);
    images.forEach((item) => { if (validId(item.groupId) && idKey(item.groupId) === key) item.groupId = null; });
    return cleanup(images);
  }

  function ungroup(images, imageIds) {
    const ids = new Set(imageIds);
    images.forEach((item) => { if (ids.has(item.id)) item.groupId = null; });
    return cleanup(images);
  }

  function move(images, movingIds, targetId, after) {
    const moving = new Set(movingIds);
    if (!moving.size || moving.has(targetId)) return images;
    const ordered = byOrder(images);
    const moved = ordered.filter((item) => moving.has(item.id));
    const remaining = ordered.filter((item) => !moving.has(item.id));
    const target = remaining.findIndex((item) => item.id === targetId);
    if (target < 0 || !moved.length) return images;
    remaining.splice(target + (after ? 1 : 0), 0, ...moved);
    replace(images, remaining);
    return normalizeLayout(images);
  }

  function moveUnit(images, imageId, delta) {
    normalizeLayout(images);
    const groups = groupMap(images);
    const units = [];
    const seen = new Set();
    byOrder(images).forEach((item) => {
      const key = validId(item.groupId) ? idKey(item.groupId) : null;
      if (key && groups.has(key)) {
        if (seen.has(key)) return;
        seen.add(key); units.push(groups.get(key));
      } else units.push([item]);
    });
    const index = units.findIndex((unit) => unit.some((item) => item.id === imageId));
    const destination = index + delta;
    if (index < 0 || destination < 0 || destination >= units.length) return images;
    [units[index], units[destination]] = [units[destination], units[index]];
    return replace(images, units.flat());
  }

  function extract(images, imageId, targetIndex) {
    const item = images.find((entry) => entry.id === imageId);
    if (!item) return images;
    item.groupId = null;
    const ordered = byOrder(images).filter((entry) => entry.id !== imageId);
    const index = Math.max(0, Math.min(ordered.length, Number(targetIndex) || 0));
    ordered.splice(index, 0, item);
    replace(images, ordered);
    return cleanup(images);
  }

  function info(images) {
    return [...groupMap(images).entries()].map(([key, members]) => ({
      id: members[0].groupId, key, members,
    })).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  }

  return { byOrder, groupMap, cleanup, normalizeIds, normalizeLayout, nextId, create,
    dropToGroup, removeGroup, ungroup, move, moveUnit, extract, info, validId, idKey };
}));
