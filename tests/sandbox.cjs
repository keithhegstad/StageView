// Loads src/main.js into a VM sandbox with just enough fake DOM/MSE to
// exercise Mp4StreamReader and StageView methods from Node.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.className = '';
    this._classes = new Set();
    const el = this;
    this.classList = {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
    };
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  // Supports the ".class" selectors the tile code uses
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (c._classes.has(cls) || c.className.split(' ').includes(cls)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
}

function loadMain() {
  const fetched = [];
  const elementsById = new Map();
  class FakeMediaSource {
    constructor() { this.readyState = 'closed'; }
    addEventListener() {}
    static isTypeSupported() { return true; }
  }
  const ctx = {
    window: { addEventListener() {}, MediaSource: FakeMediaSource },
    document: {
      createElement: (tag) => new FakeElement(tag),
      querySelector: () => null,
      // One element per id, created on first lookup
      getElementById: (id) => elementsById.get(id) || elementsById.set(id, new FakeElement('div')).get(id),
    },
    MediaSource: FakeMediaSource,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    AbortController,
    fetch: (url) => { fetched.push(url); return new Promise(() => {}); },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  };
  vm.createContext(ctx);
  // Same order as index.html: main.js uses the changelog and update helpers
  for (const file of ['changelog.js', 'updates.js', 'main.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ctx);
  }
  return {
    Reader: vm.runInContext('Mp4StreamReader', ctx),
    StageView: vm.runInContext('StageView', ctx),
    escapeHtml: vm.runInContext('escapeHtml', ctx),
    elementsById,
    window: ctx.window, // set window.__TAURI__ to stand in for the backend
    fetched,
  };
}

/** A camera tile shaped like StageView's markup: spinner + status dot. */
function fakeTile() {
  const tile = new FakeElement('div');
  tile.className = 'camera-tile';
  const spinner = new FakeElement('div'); spinner.className = 'loading-spinner';
  const status = new FakeElement('div'); status.className = 'camera-status';
  tile.appendChild(spinner);
  tile.appendChild(status);
  return { tile, spinner, status };
}

module.exports = { loadMain, fakeTile, FakeElement };
