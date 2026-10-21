const test = require('node:test');
const assert = require('node:assert');
const {
  UPDATE_CHECK_INTERVAL_MS, UPDATE_PROMPT_TIMEOUT_MS,
  isUpdateCheckDue, compareVersions, changesSince, hasPriorSetup,
  parseReleaseNotes, releaseNotesMarkdown, shouldCelebrate,
} = require('../src/updates.js');
const { CHANGELOG } = require('../src/changelog.js');

const HOUR = 3600 * 1000;

test('timings: daily checks, prompt closes after 10 minutes', () => {
  assert.strictEqual(UPDATE_CHECK_INTERVAL_MS, 24 * HOUR);
  assert.strictEqual(UPDATE_PROMPT_TIMEOUT_MS, 10 * 60 * 1000);
});

test('a check is due when never checked, or a day has passed', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  assert.strictEqual(isUpdateCheckDue(0, now), true);
  assert.strictEqual(isUpdateCheckDue(undefined, now), true);
  assert.strictEqual(isUpdateCheckDue(now - 23 * HOUR, now), false);
  assert.strictEqual(isUpdateCheckDue(now - 24 * HOUR, now), true);
});

test('a last-check time in the future (clock changed) makes a check due', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  assert.strictEqual(isUpdateCheckDue(now + 2 * HOUR, now), true);
});

test('versions compare numerically, not as text', () => {
  assert.strictEqual(compareVersions('1.10.0', '1.9.3'), 1);
  assert.strictEqual(compareVersions('1.2.1', '1.2.1'), 0);
  assert.strictEqual(compareVersions('v1.2.0', '1.3.0'), -1);
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
});

const log = [
  { version: '1.3.0', changes: [{ title: 'C', detail: 'c' }] },
  { version: '1.2.1', changes: [{ title: 'B', detail: 'b' }] },
  { version: '1.1.0', changes: [{ title: 'A', detail: 'a' }] },
];

test('changes since the last version seen, newest first', () => {
  assert.deepStrictEqual(changesSince(log, '1.1.0', '1.3.0').map((e) => e.version), ['1.3.0', '1.2.1']);
  assert.deepStrictEqual(changesSince(log, '1.2.1', '1.3.0').map((e) => e.version), ['1.3.0']);
});

test('without a known previous version, only the current version is shown', () => {
  assert.deepStrictEqual(changesSince(log, '', '1.3.0').map((e) => e.version), ['1.3.0']);
});

test('release notes round-trip through markdown', () => {
  const entry = { version: '9.9.9', changes: [
    { title: 'Live stream health', detail: 'Each camera shows its frame rate.' },
    { title: 'Daily update checks', detail: 'Asks once a day: never more.' },
  ] };
  const md = releaseNotesMarkdown(entry);
  assert.match(md, /^- \*\*Live stream health\.\*\* Each camera shows its frame rate\.$/m);
  assert.deepStrictEqual(parseReleaseNotes(md), entry.changes);
});

test('notes without bullets give no list (the old fixed release text)', () => {
  assert.deepStrictEqual(parseReleaseNotes('See the assets to download and install this version.'), []);
  assert.deepStrictEqual(parseReleaseNotes(''), []);
  assert.deepStrictEqual(parseReleaseNotes(undefined), []);
});

test('plain bullets still show, as a title without detail', () => {
  assert.deepStrictEqual(parseReleaseNotes('- Faster startup\n- Fewer glitches'),
    [{ title: 'Faster startup', detail: '' }, { title: 'Fewer glitches', detail: '' }]);
});

test('celebrate after an update, not on a fresh install or a plain restart', () => {
  assert.strictEqual(shouldCelebrate('1.2.1', '1.3.0', true), true);
  assert.strictEqual(shouldCelebrate('1.3.0', '1.3.0', true), false);
  assert.strictEqual(shouldCelebrate('1.4.0', '1.3.0', true), false, 'downgrade');
  // No record yet: a PC that has been set up before was upgraded from a version
  // before this feature; an untouched one is a fresh install.
  assert.strictEqual(shouldCelebrate('', '1.3.0', true), true);
  assert.strictEqual(shouldCelebrate('', '1.3.0', false), false);
});

test('a PC counts as set up from any trace of use, not just cameras', () => {
  assert.strictEqual(hasPriorSetup({ cameras: [{ id: 'a' }] }), true);
  assert.strictEqual(hasPriorSetup({ cameras: [], api_token: 'secret' }), true, 'token set');
  assert.strictEqual(hasPriorSetup({ cameras: [], multicast_interface: '10.0.0.4' }), true, 'adapter chosen');
  assert.strictEqual(hasPriorSetup({ cameras: [], last_update_check: 1 }), true, 'checked before');
  assert.strictEqual(hasPriorSetup({ cameras: [], window_state: { width: 800 } }), true, 'window moved');

  // A camera removed from a screen that is otherwise configured must not look
  // like a fresh install, or the celebration is lost for good.
  assert.strictEqual(hasPriorSetup({ cameras: [], api_token: '', window_state: {} }), false);
  assert.strictEqual(hasPriorSetup({}), false);
  assert.strictEqual(hasPriorSetup(null), false);
});

test('the changelog is newest first and every entry has changes', () => {
  for (let i = 1; i < CHANGELOG.length; i++) {
    assert.strictEqual(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version), 1);
  }
  for (const entry of CHANGELOG) {
    assert.ok(entry.changes.length > 0, entry.version);
    for (const c of entry.changes) assert.ok(c.title && c.detail, `${entry.version}: ${c.title}`);
  }
});
