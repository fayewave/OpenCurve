![OpenCurve](https://img.shields.io/badge/Premiere%20Pro-UXP%20Plugin-blue)
![Version](https://img.shields.io/badge/version-2.0.0-lightgrey)

<p align="left">
  <img src="img/OpenCurve2_Wordmark.png" alt="OpenCurve" width="400"/>
</p>

A free bezier curve editor plugin to add custom easing to your keyframes in Adobe Premiere Pro.

### [**Download here.**](https://github.com/fayewave/OpenCurve/releases/latest) 
### **Also available on** [**Adobe Exchange.**](https://exchange.adobe.com/apps/cc/3ecc7304/opencurve)

---

![OpenCurve: picking presets, then shaping the curve by its handles](img/readme/hero.webp)

<a href="https://www.buymeacoffee.com/fayewave">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50" />
</a>

---

### How it works
Place your playhead between 2 keyframes, select a property (position, opacity, scale, etc.), and apply your curve. OpenCurve writes the bezier handles directly to your keyframes.

<img src="img/readme/how-it-works.webp" width="720" alt="OpenCurve beside Premiere's Effect Controls: a curve is picked, Position and Scale ticked, Go pressed, and keyframes fill in between the two">

---

### Features

<p>
  <img src="img/readme/customize-your-curve.gif" width="350" hspace="1" alt="Customize your curve">
  <img src="img/readme/mini-timeline.gif" width="350" hspace="1" alt="A mini timeline of every keyframe">
  <img src="img/readme/jump-to-keyframe.gif" width="350" hspace="1" alt="Jump to the next keyframe">
  <img src="img/readme/presets.gif" width="350" hspace="1" alt="Presets, saved and shared">
  <img src="img/readme/per-property-undo.gif" width="350" hspace="1" alt="Undo, one property at a time">
</p>

- **Works anywhere** — Use on clips, nests, graphics, the Transform effect and Adjustment Layers
- **Auto-detects keyframes** — Finds keyframes on clips automatically
- **Multi-point curves** — Add points to build complex motion in a single ease, with smooth or broken handles
- **A-curve mode** — Shape the ease as a speed graph: drag the peak to where the motion is fastest
- **Presets** — Save, rename and reorder your curves, and export/import them to share
- **Mini timeline** — See every keyframed property at a glance
- **Per-property undo** — Undo a single property's ease, or load its baked curve back onto the graph, even after reopening the project
- **Undo and redo** — Supports Premiere's history system for full undo/redo support (`.ccx` version only)
- **Customization** — Themes, grid size, list/grid presets, resizable layout, full-screen graph mode, numeric entry, and more
- **Free forever** — No bloat, no logins.

---

### Installation

**Download the** [**latest release.**](https://github.com/fayewave/OpenCurve/releases/latest) 

---

### Requirements

- Adobe Premiere 2020+
- Mac & PC compatible

---

### Keyboard shortcuts:

| Key | Action |
|---|---|
| Enter | Go (bake) |
| U | Undo last bake |
| Space | Play / stop |
| J / K / L | Reverse / stop / forward |
| P | Preview the keyframe pair |
| ← → ↑ ↓ | Nudge handle (Shift = grid step) |
| F | Flip curve |
| I | Invert curve |
| A | A-curve mode |
| G | Ghost |
| N | Numeric entry |
| 1–9 | Apply preset 1–9 |
| Page Up / Down | Change preset page (.ccx only) |
| Esc | Close menu / stop preview / exit full screen |

**Graph mouse modifiers**
- **Shift-drag**: snap to grid
- **Alt-drag**: keep handles in line, but each keeps its own length
- **Ctrl/Cmd-drag**: move one handle on its own (breaks the point)

Double-click a timeline lane to select that property for baking.

In the .ccx, Space/J/K/L step the playhead without audio, because the UXP API can't play the sequence.
