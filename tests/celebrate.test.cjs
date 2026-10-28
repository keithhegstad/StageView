const test = require('node:test');
const assert = require('node:assert');
const { loadMain } = require('./sandbox.cjs');

// A StageView with a stand-in backend: records which commands ran and what was saved.
function setup({ devBuild, lastSeen }) {
  const { StageView, window } = loadMain();
  const config = { cameras: [{ id: 'a', name: 'Foaje' }], last_seen_version: lastSeen, window_state: { x: 1 } };
  const calls = [];
  let saved = null;
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push(cmd);
        if (cmd === 'is_dev_build') {
          if (devBuild === 'reject') throw new Error('unknown command is_dev_build');
          return devBuild;
        }
        if (cmd === 'get_config') return JSON.parse(JSON.stringify(config));
        if (cmd === 'save_config') saved = args.config;
        return undefined;
      },
    },
  };
  const view = Object.create(StageView.prototype);
  view.appVersion = '1.3.0';
  view._configSaveChain = Promise.resolve(); // set by the constructor in the app
  view.shown = null;
  view.showCelebration = (...args) => { view.shown = args; };
  return { view, calls, saved: () => saved };
}

test('a development build neither celebrates nor records the version', async () => {
  const { view, calls } = setup({ devBuild: true, lastSeen: '1.2.1' });
  await view.maybeCelebrateUpdate();
  assert.strictEqual(view.shown, null);
  assert.ok(!calls.includes('save_config'), 'must not mark 1.3.0 as seen');
});

test('an installed release after an update celebrates and records the version', async () => {
  const { view, saved } = setup({ devBuild: false, lastSeen: '1.2.1' });
  await view.maybeCelebrateUpdate();
  assert.strictEqual(view.shown[0], '1.3.0');
  assert.strictEqual(view.shown[1], '1.2.1');
  assert.strictEqual(saved().last_seen_version, '1.3.0');
});

test('if the build type cannot be read, behave like a release', async () => {
  const { view, saved } = setup({ devBuild: 'reject', lastSeen: '1.2.1' });
  await view.maybeCelebrateUpdate();
  assert.strictEqual(view.shown[0], '1.3.0');
  assert.strictEqual(saved().last_seen_version, '1.3.0');
});
