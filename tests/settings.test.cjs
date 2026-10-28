const test = require('node:test');
const assert = require('node:assert');
const { loadMain } = require('./sandbox.cjs');

test('escapeHtml escapes quotes so names survive inside value="…"', () => {
  const { escapeHtml } = loadMain();
  assert.strictEqual(escapeHtml(`Stage "A" & <B>'s`), 'Stage &quot;A&quot; &amp; &lt;B&gt;&#39;s');
  assert.strictEqual(escapeHtml(null), '');
});

test('video keeps using the port the server bound, not a newly typed one', () => {
  const { StageView } = loadMain();
  const view = Object.create(StageView.prototype);
  view.streamPort = 8090;
  view.apiPort = 9000; // changed in Settings; applies after a restart
  assert.strictEqual(view.streamUrl('cam1'), 'http://localhost:8090/camera/cam1/stream');
});

/** Fake backend: config lives in memory; get_config waits `delay` ms. */
function fakeBackend(window, delay) {
  let stored = { cameras: [], window_state: null, last_update_check: 0 };
  const log = [];
  window.__TAURI__ = { core: { invoke: async (cmd, args) => {
    log.push(cmd);
    if (cmd === 'get_config') {
      const snapshot = JSON.parse(JSON.stringify(stored));
      await new Promise((r) => setTimeout(r, delay));
      return snapshot;
    }
    if (cmd === 'save_config') { stored = args.config; return null; }
  } } };
  return { log, stored: () => stored };
}

test('config saves run one after another, even three deep', async () => {
  const { StageView, window } = loadMain();
  const backend = fakeBackend(window, 5);
  const view = Object.create(StageView.prototype);
  view._configSaveChain = Promise.resolve();

  const a = view.serializedConfigSave((c) => { c.cameras = [{ id: 'x' }]; return c; });
  const b = view.serializedConfigSave((c) => { c.window_state = { x: 1 }; return c; });
  await a; // before the fix, settling the first save unhooked the queue...
  const c = view.serializedConfigSave((c) => { c.last_update_check = 42; return c; });
  await Promise.all([b, c]);

  // ...so the third save ran alongside the second and one of them was lost
  assert.deepStrictEqual(backend.log, ['get_config', 'save_config', 'get_config', 'save_config', 'get_config', 'save_config']);
  assert.deepStrictEqual(backend.stored(), { cameras: [{ id: 'x' }], window_state: { x: 1 }, last_update_check: 42 });
});

test('a failed save does not block the ones after it', async () => {
  const { StageView, window } = loadMain();
  const backend = fakeBackend(window, 0);
  const view = Object.create(StageView.prototype);
  view._configSaveChain = Promise.resolve();

  await assert.rejects(view.serializedConfigSave(() => { throw new Error('bad token'); }));
  await view.serializedConfigSave((c) => { c.last_update_check = 7; return c; });
  assert.strictEqual(backend.stored().last_update_check, 7);
});

test('clicking Install twice starts one download', async () => {
  const { StageView } = loadMain();
  const view = Object.create(StageView.prototype);
  let downloads = 0;
  let finish;
  view._pendingUpdate = { downloadAndInstall: () => { downloads++; return new Promise((r) => { finish = r; }); } };

  const first = view.installUpdate();
  view.installUpdate();
  assert.strictEqual(downloads, 1);
  finish();
  await first;
});

test('Try again after a failed install downloads again', async () => {
  const { StageView } = loadMain();
  const view = Object.create(StageView.prototype);
  let downloads = 0;
  view._pendingUpdate = { downloadAndInstall: async () => { downloads++; throw new Error('network'); } };

  await view.installUpdate();
  await view.installUpdate();
  assert.strictEqual(downloads, 2);
});
