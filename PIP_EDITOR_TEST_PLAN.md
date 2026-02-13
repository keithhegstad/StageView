# PIP Editor UI - Test Plan

## Overview
This document outlines the test plan for Task 5: PIP Editor UI implementation.

## Test Scenarios

### 1. Open Layout Editor
- [ ] Click Layout Editor button in toolbar
- [ ] Verify layout editor modal opens
- [ ] Verify "Picture-in-Picture" option is available in layout type dropdown

### 2. Create New PIP Layout
- [ ] Select "Picture-in-Picture" from layout type dropdown
- [ ] Verify PIP editor UI appears with:
  - Main Camera dropdown (populated with all cameras)
  - "Overlays" section header
  - "Add Overlay" button
  - No overlays initially displayed

### 3. Select Main Camera
- [ ] Change main camera selection
- [ ] Verify selection is remembered when switching layout types
- [ ] Verify main camera cannot be selected as an overlay

### 4. Add Overlays
- [ ] Click "Add Overlay" button
- [ ] Verify new overlay appears with:
  - Camera selector dropdown
  - Corner selector buttons (↖ ↗ ↙ ↘)
  - Size dropdown (10-40%)
  - Remove button
- [ ] Verify default corner is automatically selected from available corners
- [ ] Verify default size is 25%

### 5. Configure Overlay
- [ ] Select a camera from the dropdown
- [ ] Click corner buttons to change corner position
- [ ] Verify clicked corner button becomes active (highlighted)
- [ ] Change size percentage
- [ ] Verify all changes are persisted

### 6. Corner Conflict Prevention
- [ ] Add 4 overlays (one for each corner)
- [ ] Try to add a 5th overlay
- [ ] Verify alert message: "All corners are occupied"
- [ ] Try to change an existing overlay to an occupied corner
- [ ] Verify alert message: "Corner X is already occupied"

### 7. Remove Overlay
- [ ] Click "Remove" button on an overlay
- [ ] Verify overlay is removed from the list
- [ ] Verify corner becomes available for new overlays

### 8. Save Layout
- [ ] Enter layout name
- [ ] Configure main camera and overlays
- [ ] Click "Save Layout" button
- [ ] Verify layout is saved (editor closes)

### 9. Apply Layout
- [ ] Configure a PIP layout
- [ ] Click "Apply Now" button
- [ ] Verify layout is applied immediately
- [ ] Verify main camera displays full-screen
- [ ] Verify overlays appear in correct corners with correct sizes

### 10. Load Existing PIP Layout
- [ ] Create and save a PIP layout
- [ ] Close and reopen layout editor
- [ ] Verify saved PIP layout loads correctly with:
  - Correct main camera selected
  - All overlays displayed with correct cameras, corners, and sizes

### 11. Switch Between Layout Types
- [ ] Start with Grid layout
- [ ] Switch to Picture-in-Picture
- [ ] Configure PIP layout
- [ ] Switch to Custom Positions
- [ ] Switch back to Picture-in-Picture
- [ ] Verify PIP config is preserved

### 12. Edge Cases
- [ ] Test with only 1 camera (no overlays possible)
- [ ] Test with 2 cameras (1 main, 1 overlay max)
- [ ] Test with 5+ cameras (4 overlays max)
- [ ] Test rapid clicking of Add Overlay button
- [ ] Test changing layout name after configuration
- [ ] Test closing editor without saving
- [ ] Test saving with no overlays (main camera only)

### 13. Visual Rendering
- [ ] Apply a PIP layout with overlays in all 4 corners
- [ ] Verify overlays are positioned correctly:
  - TL: Top-left with 2% margin
  - TR: Top-right with 2% margin
  - BL: Bottom-left with 2% margin
  - BR: Bottom-right with 2% margin
- [ ] Verify overlay sizes match selected percentages
- [ ] Verify overlays have higher z-index than main camera
- [ ] Verify camera labels and status dots display on overlays

### 14. Persistence
- [ ] Create and apply a PIP layout
- [ ] Close and restart the application
- [ ] Verify PIP layout is remembered
- [ ] Verify layout renders correctly on startup

## Expected Results

### UI Elements
- Main camera dropdown: Populated with all cameras
- Add Overlay button: Visible and clickable
- Overlay items: Display with camera, corner, size, and remove controls
- Corner buttons: 4 buttons (↖ ↗ ↙ ↘) in a 2x2 grid
- Size dropdown: Options from 10% to 40% in 5% increments

### Validation
- Corner conflict prevention works correctly
- Cannot add more than 4 overlays (one per corner)
- Alert messages are user-friendly and clear

### Data Structure
Layout config should be saved as:
```json
{
  "name": "My PIP Layout",
  "layout_type": "pip",
  "positions": [],
  "pip_config": {
    "main_camera_id": "camera-id-1",
    "overlays": [
      {
        "camera_id": "camera-id-2",
        "corner": "TL",
        "size_percent": 25
      },
      {
        "camera_id": "camera-id-3",
        "corner": "BR",
        "size_percent": 30
      }
    ]
  }
}
```

## Known Limitations
- Maximum 4 overlays (one per corner)
- Overlay sizes constrained to 10-40%
- Corner positions are fixed (cannot be customized)

## Success Criteria
- All test scenarios pass
- No JavaScript errors in console
- UI is responsive and intuitive
- Data persists correctly across sessions
- Layouts render correctly using Task 4's rendering logic
