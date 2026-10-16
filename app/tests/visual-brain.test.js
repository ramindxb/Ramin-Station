const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../visual-brain.js'), 'utf8');
const playerSource = source.slice(source.indexOf('function restoreExpandedMedia()'), source.indexOf('// Existing library downloads'));

function player({supportsFullscreen = false, playing = false} = {}) {
  const events = {};
  const closeKey = {addEventListener(type, fn) { events[type] = fn; }};
  const title = {textContent: ''};
  const viewer = {
    open: false,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    showModal() { this.open = true; },
    close() { this.open = false; this.listeners.close?.(); }
  };
  const document = {
    fullscreenElement: null,
    querySelector: selector => selector.includes('title') ? title : closeKey,
    addEventListener(type, fn) { events[type] = fn; },
    exitFullscreen() { this.fullscreenElement = null; return Promise.resolve(); }
  };
  if (supportsFullscreen) viewer.requestFullscreen = async () => { document.fullscreenElement = viewer; };
  const node = {controls:false, paused:!playing, currentTime:12.5, removed:false,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    remove() { this.removed = true; }
  };
  const origin = {isConnected:true, _ready:Promise.resolve(), querySelector:() => node,
    append(value) { this.restored = value; value.paused = true; }
  };
  const content = {replaceChildren(value) { this.node = value; value.paused = true; }};
  const trigger = {isConnected:true, focus() { this.focused = true; }};
  const context = {document, mediaViewer:viewer, mediaViewerContent:content, expandedMedia:null,
    showToast(message) { context.toast = message; }
  };
  vm.createContext(context);
  vm.runInContext(playerSource, context);
  return {context, viewer, content, document, origin, trigger, node, title, events};
}

test('expansion reuses the same video with controls, without cloning or losing time', async () => {
  const p = player({playing:true});
  await p.context.expandMedia(p.origin, {title:'Portrait inspiration'}, p.trigger);
  assert.equal(p.viewer.open, true);
  assert.equal(p.content.node, p.node);
  assert.equal(p.node.controls, true);
  assert.equal(p.node.currentTime, 12.5);
  assert.equal(p.node.paused, false);
  assert.equal(p.title.textContent, 'Portrait inspiration');
});

test('closing returns the player and focus, and restores compact controls', async () => {
  const p = player({supportsFullscreen:true, playing:true});
  await p.context.expandMedia(p.origin, {title:'A clip'}, p.trigger);
  p.context.closeMediaViewer();
  assert.equal(p.viewer.open, false);
  assert.equal(p.document.fullscreenElement, null);
  assert.equal(p.origin.restored, p.node);
  assert.equal(p.node.controls, false);
  assert.equal(p.node.paused, false);
  assert.equal(p.trigger.focused, true);
});

test('Escape closes the viewer when native fullscreen is unavailable', async () => {
  const p = player();
  await p.context.expandMedia(p.origin, {title:'A clip'}, p.trigger);
  let prevented = false;
  p.viewer.listeners.cancel({preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(p.viewer.open, false);
  assert.equal(p.origin.restored, p.node);
});

test('fullscreen rejection still leaves a usable full-window preview', async () => {
  const p = player();
  p.viewer.requestFullscreen = () => Promise.reject(new Error('Unsupported'));
  await p.context.expandMedia(p.origin, {title:'A clip'}, p.trigger);
  assert.equal(p.viewer.open, true);
  assert.equal(p.content.node, p.node);
});

test('a removed card cannot leave an orphaned video playing', async () => {
  const p = player({playing:true});
  await p.context.expandMedia(p.origin, {title:'A clip'}, p.trigger);
  p.origin.isConnected = false;
  p.trigger.isConnected = false;
  p.context.closeMediaViewer();
  assert.equal(p.node.paused, true);
  assert.equal(p.node.removed, true);
  assert.equal(p.viewer.open, false);
});

test('a missing preview gives feedback without opening an empty viewer', async () => {
  const p = player();
  p.origin.querySelector = () => null;
  await p.context.expandMedia(p.origin, {title:'A clip'}, p.trigger);
  assert.equal(p.viewer.open, false);
  assert.match(p.context.toast, /not ready/);
});

function motivationLibrary(items) {
  const grid = () => ({children:[], replaceChildren() { this.children = []; }, append(item) { this.children.push(item); }});
  const context = {
    state:{items}, motivationGrid:grid(), ideaGrid:grid(), activeCategory:'all', searchQuery:'',
    closeMediaViewer() {}, revokeRenderedURLs() {}, setStatus() {},
    createCard:item => item, createMotivationSlot:index => ({slot:index + 1}),
    emptyLibrary:{classList:{toggle() {}}}
  };
  vm.createContext(context);
  const limit = source.match(/const motivationLimit = \d+;/)[0];
  const capacity = source.slice(source.indexOf('function canAddToMotivation('), source.indexOf('async function addFiles('));
  const render = source.slice(source.indexOf('function render()'), source.indexOf('function categoryForDrop('));
  vm.runInContext(`${limit}\n${capacity}\n${render}`, context);
  return context;
}

test('five Motivation items fit; a sixth or oversized drop is rejected', () => {
  const pinned = () => ({category:'motivation'});
  const p = motivationLibrary([pinned(), pinned(), pinned(), {category:'saved'}]);
  assert.equal(p.canAddToMotivation(2), true);
  p.state.items.push(pinned());
  assert.equal(p.canAddToMotivation(), true);
  assert.equal(p.canAddToMotivation(2), false);
  p.state.items.push(pinned());
  assert.equal(p.canAddToMotivation(), false);
});

test('Motivation renders five slots, and keeps existing pinned cards', () => {
  const p = motivationLibrary([]);
  p.render();
  assert.equal(p.motivationGrid.children.length, 5);
  assert.equal(p.motivationGrid.children[4].slot, 5);
  p.state.items = Array.from({length:5}, (_, index) => ({id:String(index),category:'motivation'}));
  p.render();
  assert.equal(p.motivationGrid.children.length, 5);
  assert.equal(p.motivationGrid.children[4].id, '4');
  assert.equal(p.ideaGrid.children.length, 0);
});
