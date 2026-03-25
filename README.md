pot# R Plot Pro

<p align="center">
  <img src="https://raw.githubusercontent.com/ofurkancoban/RPlotPro/refs/heads/main/assets/icon.png" width="250" alt="R Plot Pro Logo">
</p>

<p align="center">
  <strong>Professional R & Julia plot visualization for VS Code</strong><br>
  The ultimate visualization experience for VS Code. High-performance, real-time, and designed for professionals who demand the best of RStudio, Positron, and Julia.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ofurkancoban.r-plot-pro"><img src="https://img.shields.io/visual-studio-marketplace/v/ofurkancoban.r-plot-pro?style=flat-square&label=VS%20Code%20Marketplace&logo=visual-studio-code" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ofurkancoban.r-plot-pro"><img src="https://img.shields.io/visual-studio-marketplace/d/ofurkancoban.r-plot-pro?style=flat-square" alt="Downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ofurkancoban.r-plot-pro"><img src="https://img.shields.io/visual-studio-marketplace/r/ofurkancoban.r-plot-pro?style=flat-square" alt="Rating"></a>
</p>

---

Tired of switching between VS Code and external windows just to see your plots? **R Plot Pro** brings the **familiar RStudio Plots pane**, **Positron's modern experience**, and **traceless Julia plotting** directly into VS Code.

### Multi-Language Power:
- ✅ **R Support** - Works with Base R and ggplot2.
- ✅ **Julia Support** - Works with CairoMakie and Plots.jl.
- ✅ **Side panel plot viewer** - Opens in the right sidebar, just like RStudio.
- ✅ **Automatic plot capture** - Every plot you create appears instantly.
- ✅ **Nuclear Stealth** - Zero initialization trace in your terminal.
- ✅ **Modern UI** - Positron-inspired design with smooth animations.

**No more context switching!** Work in VS Code with the plotting power of RStudio and the elegance of Positron.

---

## ✨ Features

### 🎨 **Real-Time Visualization**
View your **R and Julia** plots **instantly** as they're generated in the terminal. No manual refresh or external windows needed.

### 🕵️ **Nuclear Stealth Mode**
Our initialization process is virtually invisible. It automatically wipes its own traces from your terminal console, leaving your workspace professional and distraction-free.

### 📊 **Advanced Plot Gallery**
- **Thumbnail view** with timestamp and metadata
- **Drag-and-drop** plot reordering
- **Favorites system** to mark important plots
- **Filter** to show only favorited plots
- **Notes** for documenting your analysis

### 🎯 **Interactive Navigation**
- Navigate plots with **arrow keys** or navigation buttons
- **Fullscreen mode** for detailed inspection
- **Smooth transitions** between plots
- Auto-scroll active plot into view

### 🎛️ **Flexible Layouts**
- **Auto-sizing** - plots adapt to window size
- **Aspect ratio control** - square, landscape, portrait, or fill
- **Zoom controls** - 50% to 200% with fit-to-screen option
- **Sidebar toggle** for maximum plot space

### 💾 **Export & Organization**
- **Drag plots** directly to desktop/finder to save
- **Notes** on each plot for documentation
- **Plot history** - keeps last 200 plots
- **Memory optimized** - automatic cleanup

### 🎭 **Beautiful UI**
- **Dark mode** support (auto-detects VS Code theme)
- **Smooth animations** and transitions
- **Modern design** with glassmorphism effects
- **Responsive** interface
- **Split View** support with independent controls

### ✍️ **Annotations**
- **Draw** on plots with freehand tools
- **Highlight** important data points
- **Values preserved** when exporting or copying
- **Undo/Redo** support for annotations

---

## 🚀 Getting Started

### Installation

1. **Install from Marketplace:**
   ```
   ext install ofurkancoban.r-plot-pro
   ```

2. **Or install manually:**
   - Download the `.vsix` file
   - Run: `code --install-extension r-plot-pro-0.0.1.vsix`

### First Use

1. **Open an R or Julia file** in VS Code
2. **Run code** in the integrated terminal
3. **Plot viewer opens automatically** in the **right sidebar panel** when you create your first plot
4. The viewer stays open and updates in real-time as you create more plots
5. **Start plotting!** 🎉

> **💡 Tip:** The plot viewer appears as a sidebar panel (like RStudio's Plots pane), keeping your code visible while you explore visualizations. You can drag it to any position or open it manually with `View > Open View > R Plot Viewer`.

---

## 📖 Usage

### Basic Workflow

```r
# Create a plot - viewer opens automatically (R)
library(ggplot2)
ggplot(mtcars, aes(x = mpg, y = hp)) +
  geom_point(color = "steelblue", size = 3) +
  theme_minimal()
```

```julia
# Create a plot - viewer opens automatically (Julia)
using CairoMakie
f = Figure()
ax = Axis(f[1, 1], title = "Makie in VS Code")
lines!(ax, 1:10, rand(10))
f # Plot is captured instantly
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + →` | Next plot |
| `Cmd/Ctrl + ←` | Previous plot |
| `Space` | Toggle fullscreen |
| `Esc` | Exit fullscreen |

### UI Controls

**Top Toolbar:**
- **Navigation** - Previous/Next plot buttons
- **Zoom** - 50%, 75%, 100%, 150%, 200%, Fit
- **Layout** - Aspect ratio control (auto, square, landscape, portrait, fill)
- **Clear All** - Remove all plots

**Plot Thumbnail Actions:**
- **Click** - View plot
- **Star icon** - Mark as favorite
- **Note icon** - Add/edit note
- **Delete icon** - Remove plot
- **Drag** - Reorder or export

---

## 🔧 Requirements

- **VS Code** 1.85.0 or higher
- **R** 4.0.0 or higher (for R users)
- **Julia** 1.9.0 or higher (for Julia users)


---

## 📋 Features in Detail

### Plot Memory Management
- Automatically keeps last **200 plots**
- Oldest plots removed when limit reached
- Optimized memory usage (~100MB for 200 plots)

### Export Options
- **Drag-and-drop** to desktop (saves as PNG)
- High-resolution output
- Preserves aspect ratio

### Notes & Documentation
- Add notes to any plot
- Notes saved in VS Code state
- Perfect for documenting analysis steps

### Favorites
- Star important plots
- Filter view to show only favorites
- Never lose track of key visualizations

---

## 🎯 Use Cases

### Data Exploration
Quickly iterate through different visualizations while keeping a history of all attempts.

### Presentation Prep
Mark your best plots as favorites, add notes, and easily export for slides.

### Collaborative Analysis
Document your plotting process with notes for team members.

### Teaching
Show students the progression of plot improvements with before/after comparisons.

---

## ⚙️ Extension Settings

This extension works out of the box with no configuration needed. Advanced users can modify:

- Plot server port (default: auto-assigned)
- Maximum plots to keep (default: 200)
- Auto-open viewer (default: true)

---

## 🐛 Known Issues

- Plots created in background R sessions may not appear (must use VS Code terminal)
- Very large plots (>10MB) may render slowly
- Some R graphics devices may not be captured

---

## 🔄 Release Notes

### 0.2.0 - Nuclear Stealth & Julia Integration

**The Biggest Update Yet!**

- **Full Julia Support:** Seamlessly integrate Julia plotting into your VS Code workflow.
  - Supports **CairoMakie** and **Plots.jl (GR)**.
  - Intercepts all `display()` calls to route plots directly to the extension.
  - Suppresses external PNG/SVG windows for a distraction-free experience.
- **Nuclear Stealth Mode:** 
  - Trace-free terminal initialization for both R and Julia.
  - Automatically wipes the `source()` or `include()` command from the terminal buffer using advanced ANSI sequences.
  - Works even on narrow terminals with wrapped paths (up to 6 lines cleared).
- **Silent Operation:** All diagnostic logs and server-starting messages are now hidden by default for a clean terminal experience.

### 0.1.0 - Julia Beta Release

- Initial support for Julia language.
- WebSocket-based real-time communication.

### 0.0.61 - Full Static Wait & Color Picker Fix

**New Features:**

- **Perfect Static Wait:** Fixed the issue where color swatches would shrink on hover-off. Now the entire palette remains 100% static for the 2-second delay.
- **Flex-Stable Layout:** Added `flex-shrink: 0` to internal components to prevent any sub-pixel layout shifts during the transition wait.
- **Synchronized Fading:** Color buttons now fade out in perfect sync with the toolbar frame.

### 0.0.60 - Zero-Shrink Delay & Drag Handle Fix

**New Features:**

- **Zero-Shrink Delay:** Synchronized every internal property (margins, handle size, button widths) to ensure the toolbar remains absolutely stationary for the full 2-second buffer.
- **Perfect Sync:** All components now collapse simultaneously without intermediate "staged" or "half-shrunk" visual states.
- **Improved UI Stability:** No more "ghost shrinking" on hover-off; the toolbar stays fully expanded until the count-down is complete.

### 0.0.59 - Pro Animation & Unified Collapse

**New Features:**

- **Zero-Bounce Animation:** Replaced the bouncy transition with a smooth `ease-in-out` for a more professional and stable feel.
- **Unified Collapse:** Synchronized child elements (buttons, separators, etc.) with the parent's closing duration for a clean, non-staged closing experience.
- **Smooth Buffer:** Maintained the 2-second collapse delay while ensuring the transition itself is seamless and fast when it triggers.

### 0.0.58 - Stable Delay & Smooth Transitions

**New Features:**

- **Rock-Solid Collapse Delay:** Transitioned to `max-width`/`max-height` logic to ensure the 2-second closing delay is perfectly respected by the browser.
- **Zero-Lag Dragging:** Position updates (`left`/`top`) now have no delay, ensuring the toolbar follows your mouse instantly while maintaining the collapse buffer.
- **UI Refinement:** Further improved the symmetry of the collapsed "pill" state for a cleaner first impression.

### 0.0.57 - Equilateral Arrows & Smooth Dragging

**New Features:**

- **Equilateral Arrow Heads:** Redesigned the arrow geometry to form a perfect 60-degree equilateral triangle for a balanced, professional look.
- **Selective Transition Delays:** Position updates (dragging) are now instantaneous, while the size collapse maintains the 2-second buffer delay.
- **Refined Horizontal Handle:** The horizontal drag handle now features a clearer 6-dot icon (`⠿`).

### 0.0.56 - Stable Handling & Collapse Delay

**New Features:**

- **Transition Delay:** The annotation bar now waits for 2 seconds before collapsing, preventing accidental closures.
- **Stable Dragging:** The toolbar remains fully expanded and stable while being moved, eliminating flickering.
- **Pixel-Perfect Centering:** Refined the collapsed state to ensure the active tool is perfectly centered in a clean circular frame.

### 0.0.55 - Symmetrical UI & Ultra-Sharp Arrows

**New Features:**

- **Perfect Symmetry:** The annotation palette is now a perfect circle when collapsed, with the active icon precisely centered.
- **Ultra-Sharp Arrows:** Redesigned arrow geometry and line-end calculations for perfectly pointy and professional tips.
- **Enhanced Visibility:** Drag handle "dots" are now bolder and clearer when the palette is expanded.

### 0.0.54 - Smart Palette & Sharp Arrows

**New Features:**

- **Auto-Expanding Palette:** The annotation bar now stays collapsed, showing only the active tool, and unfolds elegantly when hovered.
- **Improved Arrow Geometry:** Significantly sharper and more professional arrow heads for clearer annotations.
- **Enhanced Positioning:** Horizontal layout and top-left alignment by default for new users.

### 0.0.53 - Enhanced Annotation Bar

**New Features:**

- **Dynamic Annotation Palette:**
  - **Draggable:** Move the toolbar anywhere in the plot area via the new drag handle.
  - **Orientation Toggle:** Switch between horizontal and vertical layouts.
  - **Auto-Scaling:** The palette automatically shrinks on smaller screens to maximize plot visibility.
  - **Persistent State:** Saves your preferred position and orientation.

### 0.0.52 - Split View & UI Refinements

**New Features:**
- **Enhanced Split View:**
  - **Side-by-Side Export:** Saving or copying in split mode now captures both plots combined.
  - **Real-time Resizing:** Draggable splitter with smooth plot resizing.
  - **Improved Labels:** Plot indicators remain visible during interaction.
  - **Annotations:** Draw and highlight directly on plots before exporting.
- **UI Refinements:**
  - **Dark Mode:** Now uses pure black (`#000000`) for seamless integration with inverted plots.
  - **Sidebar:** Thumbnails panel opens by default for instant access.
  - **Startup:** Extension defaults to Light Mode for better initial visibility.
- **Performance:**
  - Optimized resize events and memory usage.
  - Fixed "No Plot" screen transitions.

### 0.0.1 - Initial Release

**Features:**
- Real-time plot visualization
- Advanced plot gallery with thumbnails
- Favorites and notes system
- Drag-and-drop export
- Multiple zoom and aspect ratio options
- Dark mode support

**Bug Fixes:**
- Fixed WebSocket timing issues
- Improved error handling
- Optimized resize events

---

## 🙏 Support

If you find R Plot Pro useful, consider supporting its development!

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/ofurkanco)

---

## 📝 License

MIT License - feel free to use in your projects!

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

**Enjoy plotting!** 📊✨
