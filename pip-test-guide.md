# PIP Layout Testing Guide

## Testing the PIP Rendering Implementation

This guide will help you test the newly implemented Picture-in-Picture (PIP) rendering functionality in StageView.

## Prerequisites

1. StageView must be running with at least 2 cameras configured
2. Open the browser DevTools (F12 or Ctrl+Shift+I)
3. Navigate to the Console tab

## Test 1: Create a Simple PIP Layout

Paste the following code into the browser console to create a test PIP layout:

```javascript
// Create a test PIP layout with Camera 1 as main and Camera 2 in the bottom-right corner
const testPipLayout = {
  name: "Test PIP Layout",
  layout_type: "pip",
  positions: [], // Not used for PIP layouts
  pip_config: {
    main_camera_id: app.cameras[0].id,
    overlays: [
      {
        camera_id: app.cameras[1].id,
        corner: "BR", // Bottom-Right
        size_percent: 25
      }
    ]
  }
};

// Add the layout to the app
app.layouts.push(testPipLayout);
app.activeLayout = "Test PIP Layout";
app.layoutMode = "pip";

// Render the PIP layout
app.render();

console.log("✅ Test PIP layout created and rendered!");
```

### Expected Results:
- Camera 1 should fill the entire screen (main camera)
- Camera 2 should appear in the bottom-right corner at 25% size
- The overlay should have a 2% margin from the bottom and right edges
- The overlay should appear on top of the main camera (z-index layering)

## Test 2: Multiple Overlays in Different Corners

Test all four corner positions:

```javascript
// Create a PIP layout with overlays in all four corners
const multiPipLayout = {
  name: "Multi-Corner PIP",
  layout_type: "pip",
  positions: [],
  pip_config: {
    main_camera_id: app.cameras[0].id,
    overlays: [
      {
        camera_id: app.cameras[1].id,
        corner: "TL", // Top-Left
        size_percent: 20
      },
      {
        camera_id: app.cameras[2]?.id || app.cameras[1].id,
        corner: "TR", // Top-Right
        size_percent: 20
      },
      {
        camera_id: app.cameras[3]?.id || app.cameras[1].id,
        corner: "BL", // Bottom-Left
        size_percent: 20
      },
      {
        camera_id: app.cameras[4]?.id || app.cameras[1].id,
        corner: "BR", // Bottom-Right
        size_percent: 20
      }
    ]
  }
};

app.layouts.push(multiPipLayout);
app.activeLayout = "Multi-Corner PIP";
app.layoutMode = "pip";
app.render();

console.log("✅ Multi-corner PIP layout created!");
```

### Expected Results:
- Camera 1 fills the screen (main)
- Four overlay cameras appear in all four corners
- Each overlay is 20% of screen size
- All overlays have 2% margins from their respective edges
- Z-index increases for each overlay (10, 11, 12, 13)

## Test 3: Different Sizes

Test the size_percent parameter (valid range: 10-40):

```javascript
// Test different overlay sizes
const sizePipLayout = {
  name: "Size Test PIP",
  layout_type: "pip",
  positions: [],
  pip_config: {
    main_camera_id: app.cameras[0].id,
    overlays: [
      {
        camera_id: app.cameras[1].id,
        corner: "TL",
        size_percent: 15 // Small
      },
      {
        camera_id: app.cameras[2]?.id || app.cameras[1].id,
        corner: "TR",
        size_percent: 25 // Medium
      },
      {
        camera_id: app.cameras[3]?.id || app.cameras[1].id,
        corner: "BR",
        size_percent: 35 // Large
      }
    ]
  }
};

app.layouts.push(sizePipLayout);
app.activeLayout = "Size Test PIP";
app.layoutMode = "pip";
app.render();

console.log("✅ Size test PIP layout created!");
```

### Expected Results:
- Top-left overlay: 15% size (small)
- Top-right overlay: 25% size (medium)
- Bottom-right overlay: 35% size (large)
- All maintain proper aspect ratios and positioning

## Test 4: Fallback to Grid

Test that the PIP renderer falls back gracefully when there's no pip_config:

```javascript
// Create a PIP layout without pip_config (should fallback to grid)
const fallbackLayout = {
  name: "Fallback Test",
  layout_type: "pip",
  positions: []
  // No pip_config - should fallback to grid
};

app.layouts.push(fallbackLayout);
app.activeLayout = "Fallback Test";
app.layoutMode = "pip";
app.render();

console.log("✅ Fallback test complete - should show grid layout");
```

### Expected Results:
- The app should fallback to grid layout rendering
- No errors in the console
- All cameras displayed in auto-grid format

## Test 5: Reset to Normal Grid

Return to the default grid view:

```javascript
// Reset to grid view
app.activeLayout = "Default Grid";
app.layoutMode = "grid";
app.render();

console.log("✅ Reset to grid view");
```

## Visual Checks

For each test, verify:

1. **Main Camera**:
   - Fills 100% of the viewport
   - z-index: 1
   - Positioned at (0, 0)

2. **Overlay Cameras**:
   - Correct corner positioning with 2% margin
   - Correct size percentage
   - z-index: 10+ (overlays appear on top)
   - Aspect ratio maintained (square overlays)

3. **Interactive Features**:
   - Double-click on tiles still works for solo mode
   - Status dots appear/hide correctly
   - Camera labels visible (if enabled)
   - Loading spinners work

4. **Stream Playback**:
   - All cameras receive and display frames
   - No performance degradation
   - Overlays don't interfere with main camera stream

## Cleanup

Remove test layouts from the app:

```javascript
// Remove test layouts
app.layouts = app.layouts.filter(l => !l.name.includes("Test") && !l.name.includes("Multi-Corner") && !l.name.includes("Size") && !l.name.includes("Fallback"));
app.activeLayout = "Default Grid";
app.layoutMode = "grid";
app.render();

console.log("✅ Test layouts removed, back to default grid");
```

## Known Limitations

1. The PIP editor UI is not yet implemented (Task 5)
2. Saving PIP layouts to config requires the backend save logic
3. Corner strings must be uppercase ("TL", "TR", "BL", "BR")

## Troubleshooting

**Issue**: Overlays don't appear
- Check that camera IDs in pip_config.overlays match actual camera IDs
- Verify cameras array has enough cameras for the test
- Check browser console for errors

**Issue**: Wrong positioning
- Verify corner values are "TL", "TR", "BL", or "BR"
- Check that margins are being applied (inspect element styles)

**Issue**: Z-index issues (overlays behind main)
- Verify main camera has z-index: 1
- Verify overlays have z-index: 10+
- Check for CSS conflicts in styles.css

## Success Criteria

The implementation is successful if:
- ✅ Main camera renders at 100% size with z-index: 1
- ✅ Overlays render in correct corners with 2% margins
- ✅ Overlays use correct size_percent dimensions
- ✅ Overlays have z-index: 10+ and appear on top
- ✅ All cameras receive and display video frames
- ✅ Fallback to grid works when pip_config is missing
- ✅ No console errors during rendering
- ✅ Double-click and other interactions still work
