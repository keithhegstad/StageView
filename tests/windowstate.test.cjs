const test = require('node:test');
const assert = require('node:assert');
const { loadMain } = require('./sandbox.cjs');

/** A Tauri window stand-in; Windows parks minimized windows at -32000. */
function fakeWindow(state) {
  return {
    isMinimized: async () => state.minimized,
    isMaximized: async () => false,
    outerPosition: async () => (state.minimized ? { x: -32000, y: -32000 } : { x: state.x, y: state.y }),
    outerSize: async () => (state.minimized ? { width: 160, height: 28 } : { width: 1296, height: 759 }),
  };
}

function setup() {
  const { StageView, window } = loadMain();
  const saved = [];
  let stored = { window_state: null };
  window.__TAURI__ = { core: { invoke: async (cmd, args) => {
    if (cmd === 'get_config') return JSON.parse(JSON.stringify(stored));
    if (cmd === 'save_config') { stored = args.config; saved.push(args.config.window_state); }
  } } };
  const view = Object.create(StageView.prototype);
  view._configSaveChain = Promise.resolve();
  return { view, saved };
}

test('a minimized window keeps its last real position', async () => {
  const { view, saved } = setup();
  const state = { minimized: false, x: 140, y: 120 };
  const win = fakeWindow(state);

  await view.saveWindowState(win);
  state.minimized = true;
  await view.saveWindowState(win);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved)), [{ x: 140, y: 120, width: 1296, height: 759, maximized: false }]);
});

test('an unchanged window is not saved twice; a moved one is', async () => {
  const { view, saved } = setup();
  const state = { minimized: false, x: 140, y: 120 };
  const win = fakeWindow(state);

  await view.saveWindowState(win);
  await view.saveWindowState(win);
  state.x = 300;
  await view.saveWindowState(win);

  assert.deepStrictEqual(saved.map((s) => s.x), [140, 300]);
});
