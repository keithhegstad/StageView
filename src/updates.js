// ── Update schedule, versions and release notes ─────────────────────────────
// Pure helpers behind the update prompt and the post-update curtain call, kept
// free of the DOM so they can be tested. The release build uses
// releaseNotesMarkdown() to turn src/changelog.js into the GitHub release notes,
// which the updater hands back to the app as `update.body`.

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const UPDATE_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;      // prompt steps aside after 10 minutes

/** True when the last check was a day or more ago (or never, or in the future). */
function isUpdateCheckDue(lastCheckMs, nowMs) {
  if (!lastCheckMs) return true;
  if (lastCheckMs > nowMs) return true; // clock moved backwards: don't wait for it to catch up
  return nowMs - lastCheckMs >= UPDATE_CHECK_INTERVAL_MS;
}

/** Numeric version comparison: 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a, b) {
  const parts = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Changelog entries after `fromVersion` up to and including `toVersion`, newest first.
 * Without a known previous version, just the current version's entry.
 */
function changesSince(changelog, fromVersion, toVersion) {
  return changelog
    .filter((e) => (fromVersion
      ? compareVersions(e.version, fromVersion) > 0 && compareVersions(e.version, toVersion) <= 0
      : compareVersions(e.version, toVersion) === 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** One changelog entry as release-note markdown: "- **Title.** Detail" per change. */
function releaseNotesMarkdown(entry) {
  return entry.changes.map((c) => `- **${c.title}.** ${c.detail}`).join('\n');
}

/** Release notes back into { title, detail } items. Text without bullets gives []. */
function parseReleaseNotes(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => {
      const text = line.replace(/^[-*]\s+/, '');
      const m = text.match(/^\*\*(.+?)\.?\*\*\s*(.*)$/);
      return m ? { title: m[1], detail: m[2] } : { title: text, detail: '' };
    });
}

/**
 * Show the curtain call when this version is newer than the last one this PC ran.
 * With no record (versions before this feature never saved one), an existing
 * set-up with cameras counts as upgraded; an empty one is a fresh install.
 */
function shouldCelebrate(lastSeenVersion, currentVersion, hasCameras) {
  if (!lastSeenVersion) return !!hasCameras;
  return compareVersions(currentVersion, lastSeenVersion) > 0;
}

if (typeof module !== 'undefined') {
  module.exports = {
    UPDATE_CHECK_INTERVAL_MS, UPDATE_PROMPT_TIMEOUT_MS,
    isUpdateCheckDue, compareVersions, changesSince,
    parseReleaseNotes, releaseNotesMarkdown, shouldCelebrate,
  };
}
