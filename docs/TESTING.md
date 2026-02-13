# StageView Testing Checklist

## Foundation Features

### Git & Documentation
- [ ] `.gitignore` properly excludes build artifacts and binaries
- [ ] README renders correctly on GitHub
- [ ] All installation instructions work on target platforms
- [ ] API documentation matches actual endpoints

### Auto-Reconnection
- [ ] Camera reconnects after network drop
- [ ] Exponential backoff increases delay correctly (1s, 2s, 4s, 8s...)
- [ ] Status dot shows orange pulsing during reconnection
- [ ] After 10 attempts, retry resets with longer delay
- [ ] Successful reconnection shows green status dot

## Feature Enhancements

### Stream Health Stats
- [ ] FPS displays correctly for each camera
- [ ] Bitrate updates every 2 seconds
- [ ] Frame count increments
- [ ] Uptime shows hours:minutes:seconds format
- [ ] Stats persist when settings panel is closed and reopened

### Custom Layouts
- [ ] Grid layout arranges cameras in square grid
- [ ] Custom layout positions cameras at specified x/y coordinates
- [ ] PIP layout shows main camera full screen with overlays
- [ ] Z-index controls layering correctly
- [ ] Layout persists after app restart

### Layout Editor
- [ ] Layout editor opens via toolbar button
- [ ] Changing layout type updates position editors
- [ ] PIP auto-generation creates correct positions
- [ ] Manual position adjustments (x, y, width, height) work
- [ ] Save Layout persists to config
- [ ] Apply Layout switches view immediately

### Camera Presets
- [ ] Save Preset stores current camera list
- [ ] Load Preset restores cameras and restarts streams
- [ ] Delete Preset removes from list
- [ ] Preset names display in settings panel
- [ ] Presets persist across app restarts

### Drag-and-Drop Reordering
- [ ] Dragging camera tile shows visual feedback (opacity, scale)
- [ ] Dropping on another tile swaps positions
- [ ] Camera order persists after app restart
- [ ] Drag disabled in solo mode
- [ ] Drag cursor changes (grab/grabbing)

### Multi-Monitor Support
- [ ] Window position saves when moved
- [ ] Window size saves when resized
- [ ] Window restores to correct monitor on launch
- [ ] Maximized state persists
- [ ] Works correctly on multi-monitor setups

## Regression Testing

### Core Functionality (ensure not broken)
- [ ] Multi-camera grid displays correctly
- [ ] Solo mode works (double-click, number keys)
- [ ] Burn-in protection shuffle still works
- [ ] Pixel orbiting still works
- [ ] Noise overlay still works
- [ ] Remote API endpoints still respond
- [ ] Settings panel saves configuration
- [ ] Quality presets (low/medium/high) work
- [ ] Keyboard shortcuts (F11, 1-9, 0, ESC) work

## Cross-Platform Testing

### Windows
- [ ] FFmpeg binary bundled correctly
- [ ] Config saves to `%APPDATA%\StageView\`
- [ ] Installer works (.msi)
- [ ] All features functional

### macOS
- [ ] FFmpeg bundled or uses system FFmpeg
- [ ] Config saves to `~/Library/Application Support/StageView/`
- [ ] DMG installer works
- [ ] All features functional

### Linux
- [ ] FFmpeg installed or bundled
- [ ] Config saves to `~/.config/StageView/`
- [ ] AppImage works
- [ ] All features functional

## Performance Testing

- [ ] 4 cameras: smooth at high quality
- [ ] 9 cameras: smooth at medium quality
- [ ] 16 cameras: smooth at low quality
- [ ] CPU usage reasonable (<30% for 9 cameras)
- [ ] Memory usage stable (no leaks)
- [ ] Reconnection doesn't cause memory spike

## Edge Cases

- [ ] Empty camera list doesn't crash
- [ ] Invalid camera URL shows error status
- [ ] Duplicate camera names handled
- [ ] Very long camera names truncate gracefully
- [ ] Rapid layout switching doesn't crash
- [ ] Deleting active layout falls back to grid
- [ ] Loading preset with non-existent cameras handled
