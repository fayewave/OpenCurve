# OpenCurve

A bezier curve editor plugin for Adobe Premiere Pro, built with UXP.

Design and apply custom easing curves to your keyframes — save presets, share them with your team, and keep your motion consistent across projects.

![OpenCurve](https://img.shields.io/badge/Premiere%20Pro-UXP%20Plugin-blue)
![Version](https://img.shields.io/badge/version-1.0.0-lightgrey)

---

## Features

- **Curve editor** — drag control handles to shape your bezier curve in real time
- **Presets** — save curves as named presets, rename them, reorder by drag, delete when done
- **Copy & paste coordinates** — right-click any preset to copy its `cubic-bezier()` value; right-click the preset panel to paste and instantly create a new preset from it — great for sharing curves with others
- **Custom curve colour** — pick any colour for the graph line and control points from the Settings panel
- **Check for updates** — get notified when a new version is available, directly inside the plugin
- **Resizable panel** — drag the divider to adjust the graph/preset split to your preference

---

## Installation

1. Download `OpenCurve-1.0.0.ccx` from the [latest release](https://github.com/fayewave/OpenCurve/releases/latest)
2. Double-click the `.ccx` file
3. Creative Cloud will prompt you to confirm — click **Install**
4. Open Premiere Pro and find OpenCurve under **Window → Extensions**

---

## Sharing Presets

Curves can be shared as plain text in the standard `cubic-bezier()` format:

1. Right-click a preset → **Copy Coordinates**
2. Share the text with a colleague
3. They right-click in the preset panel → **Paste Coordinates** → paste the value → **Add Preset**

---

## Requirements

- Adobe Premiere Pro 2024 or later
- Creative Cloud desktop app (for installation)

---

## Made by [faye](https://github.com/fayewave)
