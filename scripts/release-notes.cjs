// Prints the GitHub release notes for one version from src/changelog.js.
// The release workflow publishes this as the release body, which the updater
// shows in the update prompt. Exits with an error when the version has no
// entry, so a release can't go out without its notes.
const { CHANGELOG } = require('../src/changelog.js');
const { releaseNotesMarkdown, compareVersions } = require('../src/updates.js');

const version = String(process.argv[2] || '').replace(/^v/, '');
const entry = CHANGELOG.find((e) => compareVersions(e.version, version) === 0);
if (!version || !entry) {
  console.error(`No entry for version "${version}" in src/changelog.js. Add one before releasing.`);
  process.exit(1);
}
process.stdout.write(releaseNotesMarkdown(entry) + '\n');
