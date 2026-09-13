![OpenCurve](https://img.shields.io/badge/Premiere%20Pro-UXP%20Plugin-blue)
![Version](https://img.shields.io/badge/version-2.0.0-lightgrey)

<p align="left">
  <img src="img/OpenCurve2_Wordmark.png" alt="OpenCurve" width="400"/>
</p>

A free bezier curve editor plugin to add custom easing to your keyframes in Adobe Premiere Pro.

**Download the** [**latest release.**](https://github.com/fayewave/OpenCurve/releases/latest) 

**Also available on** [**Adobe Exchange.**](https://exchange.adobe.com/apps/cc/3ecc7304/opencurve)

---

![OpenCurve screenshot](img/v2-dev-1.png)

---

### How it works
Place your playhead between 2 keyframes, select a property (position, opacity, scale, etc.), and apply your curve. OpenCurve writes the bezier handles directly to your keyframes.

---

### Features
- **Works anywhere** — Use on clips, nests, graphics, the Transform effect and Adjustment Layers
- **Auto-detects keyframes** — Finds keyframes on clips at the playhead without requiring you to select them first
- **Multi-point curves** — Add points to build complex motion in a single ease, with smooth or broken handles
- **A-curve mode** — Shape the ease as a speed graph: drag the peak to where the motion is fastest
- **Overshoot and bounce** — Handles can leave the 0–1 box, so anticipation, overshoot and bounce eases just work
- **Flip and invert** — One click turns an ease-in into an ease-out, or into its inverse
- **Numeric entry** — Type exact handle values, or paste a `cubic-bezier()`
- **Presets** — Save, rename and reorder your curves, start from a built-in pack (Ease, Cubic, Quint, Expo, Back, Bounce) and export/import them to share
- **Mini timeline** — See every keyframed property at a glance, click to jump, hover to read values
- **Per-property undo** — Undo a single property's ease, or load its baked curve back onto the graph, even after reopening the project
- **Preview** — Press P to play the playhead through the eased keyframes
- **Keyframe spacing** — Bake a keyframe every frame for an exact match, or every 2 or 4 frames for a lighter timeline
- **Keyboard shortcuts** — Enter to apply, 1–9 for presets, arrows to nudge, Space / J K L for playback, and more
- **Snap to grid** — Hold Shift to snap handles to the grid
- **Undo and redo** — Supports Premiere's history system for full undo/redo support (`.ccx` version only)
- **Customization** — Themes, grid size, list/grid presets, resizable layout and a full-screen graph
- **Free forever** — No bloat, no logins. Made by an actual video editor for the editing community

---

### What's new in 2.0

**Curves**
- Multi-point curves and A-curve (speed graph) mode
- Overshoot, anticipation and bounce eases
- Flip, invert and numeric entry
- Square graph, zoom, full-screen mode and a ghost of the curve while you drag

**Workflow**
- New mini timeline with keyframe lanes, click-to-jump and live value readout
- Per-property undo, plus an Undo button next to Go
- Baked curves are remembered and can be reloaded, even after restarting Premiere
- Playhead jump buttons that step through every keyframed area on a clip
- Playback preview and a full set of keyboard shortcuts
- Choose keyframe spacing (every 1, 2 or 4 frames)

**Presets**
- Starter pack of 16 classic eases
- Export and import preset files
- Hover a preset to preview its motion

**Interface & performance**
- Redesigned panel with toolbars and a resizable graph, presets and timeline
- Keyframe detection reacts instantly when the playhead moves
- Smoother scrolling and faster polling in both editions
- Show or hide the graph and timeline to fit any panel size

---

### Installation

#### Premiere 2025 or newer:
1. Download the `.ccx` file in the [latest release](https://github.com/fayewave/OpenCurve/releases/latest)
2. Open the `.ccx` file
3. Creative Cloud will prompt you to confirm — click **Install**
4. Open Premiere Pro and find OpenCurve under **Window → UXP Plugins**

#### Premiere 2024 or older:
1. Download the `.zxp` file in the [latest release](https://github.com/fayewave/OpenCurve/releases/latest)
2. Install the `.zxp` file using [aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/) (free).
4. Open Premiere Pro and find OpenCurve under **Window → Extensions**
> ⚠️Warning: The `.zxp` version uses a dedicated Undo button (next to Go) instead of Ctrl+Z/Command+Z due to Premiere limitations. If you're using Premiere 2025 or later, I **highly recommend** using the `.ccx` version instead. It's faster and better.

---

### Requirements

- Adobe Premiere 2020+
- Mac & PC compatible

---

<a href="https://www.buymeacoffee.com/fayewave">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60" />
</a>

