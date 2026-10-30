'use strict';
const assert = require('node:assert/strict');
const G = require('../comic_studio/static/groups.js');
const images = (count) => Array.from({ length: count }, (_, order) => ({ id: `p${order}`, order, selected: true, groupId: null }));

{
  const items = images(5);
  assert.equal(G.create(items, ['p0', 'p1']), 1);
  assert.deepEqual(items.map((item) => item.groupId), [1, 1, null, null, null]);
  assert.equal(G.dropToGroup(items, ['p2'], 'p0'), 1);
  assert.deepEqual(items.map((item) => item.id), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(items.slice(0, 3).map((item) => item.groupId), [1, 1, 1]);
  G.move(items, ['p0'], 'p2', false); // reorder within a group, without splitting it
  assert.deepEqual(G.info(items)[0].members.map((item) => item.id), ['p1', 'p0', 'p2']);
  G.moveUnit(items, 'p0', 1);
  assert.equal(G.info(items)[0].members.length, 3);
  G.extract(items, 'p1', 4);
  assert.equal(items.find((item) => item.id === 'p1').groupId, null);
  assert.equal(G.info(items)[0].members.length, 2);
}
{
  const items = images(4);
  G.create(items, ['p0', 'p1']);
  G.create(items, ['p2', 'p3']);
  G.create(items, ['p0', 'p1', 'p2', 'p3']);
  assert.equal(G.info(items).length, 1);
  assert.equal(G.info(items)[0].members.length, 4);
  G.removeGroup(items, 1);
  assert.equal(G.info(items).length, 0);
}
{
  const items = images(3);
  items[0].groupId = 'گروه قدیمی'; items[1].groupId = 'گروه قدیمی';
  G.normalizeLayout(items);
  assert.equal(typeof items[0].groupId, 'number');
  assert.equal(G.info(items).length, 1);
}
console.log('group logic: all assertions passed');
