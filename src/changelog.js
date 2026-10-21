// ── What changed in each version ────────────────────────────────────────────
// Newest first. Shown after an update (the curtain call) and published as the
// GitHub release notes, which is what the update prompt shows on other PCs.
// The release build fails if the version being released has no entry here.
// Write for the people watching the screens: what they'll notice, in plain words.

const CHANGELOG = [
  {
    version: '1.3.0',
    changes: [
      {
        title: 'Daily update checks',
        detail: 'StageView looks for a new version once a day, so screens that run for weeks stay current.',
      },
      {
        title: 'The update prompt steps aside',
        detail: 'If nobody answers within 10 minutes it closes by itself and asks again at the next daily check.',
      },
      {
        title: 'See what changed',
        detail: 'The update prompt lists what is new in a version, and so does the screen you see after updating.',
      },
    ],
  },
  {
    version: '1.2.1',
    changes: [
      {
        title: 'Cameras find the right network',
        detail: 'Multicast cameras now join on the camera network adapter, even with VPN, Hyper-V, WSL or Docker adapters active. You can choose the adapter in Settings.',
      },
      {
        title: 'Live stream health',
        detail: "Settings shows each camera's frame rate over the last three minutes, with dips and dropouts marked.",
      },
      {
        title: 'A calmer interface',
        detail: 'New camera labels, toolbar, camera menu and settings, made to read well from across a room.',
      },
      {
        title: 'Recovers on its own',
        detail: 'Streams can no longer outlive StageView or block it after a restart, and a camera that falls behind picks up again at the next clean frame.',
      },
      {
        title: 'More cameras supported',
        detail: 'RTSP cameras work again, and H.265 cameras play on PCs that can decode them.',
      },
      {
        title: 'Safer on the network',
        detail: 'Camera video is only shown to StageView itself, and remote control can require an access token.',
      },
    ],
  },
];

if (typeof module !== 'undefined') module.exports = { CHANGELOG };
