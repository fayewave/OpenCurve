# OpenCurve

A bezier curve editor to add custom easing to your keyframes in Premiere Pro. No purchases. No bloatware.

![OpenCurve](https://img.shields.io/badge/Premiere%20Pro-UXP%20Plugin-blue)
![Version](https://img.shields.io/badge/version-1.0.1-lightgrey)

---

## Features

### Bezier curve editor
The core of OpenCurve is a visual bezier graph with two draggable control handles. Each handle controls one side of the easing curve — drag them to shape exactly how a property accelerates or decelerates between keyframes.

Unlike Premiere Pro's built-in easing (Ease In, Ease Out, Linear), OpenCurve gives you precise, custom curves with immediate visual feedback. What you see in the graph is exactly what gets applied.

### Keyframe easing
Place your playhead on or between keyframes, select a property (position, opacity, scale, etc.), and apply your curve. OpenCurve writes the bezier handles directly to your keyframes — no manual handle dragging in the timeline required.

This is especially useful for:
- **Motion design** — craft smooth, intentional acceleration and deceleration rather than relying on guesswork
- **Consistency** — apply the exact same curve to multiple properties or clips without re-drawing it each time
- **Speed** — iterate on timing quickly by tweaking the graph and re-applying, rather than adjusting individual keyframe handles in the timeline

### Presets
Save any curve as a named preset with a single click. Presets are persistent across sessions and can be reordered by drag. Build up a personal library of easing styles — snappy, bouncy, smooth, cinematic — and apply them instantly.

### Sharing curves
Every curve has a standard `cubic-bezier()` value behind it. Right-click any preset to copy its coordinates as text, and share it with anyone — paste it into a message, a shared doc, or a style guide. The recipient right-clicks the preset panel in their own OpenCurve and pastes it straight in as a new preset.

### Settings
- **Custom curve colour** — change the colour of the graph line and control points to suit your workspace
- **Update notifications** — get notified inside the plugin when a new version is available
- **Reset** — restore all settings to defaults

---

## Installation

1. Download the [latest release](https://github.com/fayewave/OpenCurve/releases/latest)
2. Double-click the `.ccx` file
3. Creative Cloud will prompt you to confirm — click **Install**
4. Open Premiere Pro and find OpenCurve under **Window → Extensions**

---

## Requirements

- Adobe Premiere Pro 2024 or later
- Creative Cloud desktop app (for installation)

---
