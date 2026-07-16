# R Plot Pro - Release Notes

## v0.52.0 - Native theme sync

### Improved
- **Theme sync update** - Removed the forced dark mode at startup that was based on VS Code theme classes (`vscode-dark`). The extension now relies entirely on IDE-synced CSS variables for a seamless and native look without the jarring dark background on initial launch.

## v0.51.0 - ggplot2 inspect, presentation mode, laser pointer & quarto fix

### New
- **ggplot2 inspect support** - hover read-out, nearest-point snapping, the measure tool and zoom-to-region now work on single-panel Cartesian ggplots, not just base graphics. The server re-prints the ggplot during capture, reads the panel rect from the live grid viewport tree and the axis ranges, log transforms and layer points from ggplot_build. Facets and polar coordinates fall back gracefully. Zoom-to-region emits a ready-to-add coord_cartesian() layer for ggplots.
- **Presentation mode** - walk ALL plots full screen inside the panel (settings menu entry or the P key). Arrows or space navigate, C toggles a source-code overlay, notes show as captions, Esc exits.
- **Laser pointer** - a toolbar toggle (or the L key) turns the cursor into a glowing red dot over the plot; hold the mouse button and drag to leave a GoodNotes-style comet trail that dissolves after about 0.7s. Only active over plot images and disabled while the gallery is empty.

### Fixed
- **Quarto / knitr / Rscript no longer break** - the .Rprofile hook sourced init.R in non-interactive R too, and the null graphics device plus plot traces crashed quarto's R engine (could not find function "execute"). init.R is now a no-op unless the session is interactive.
- **First render fits the panel** - initial captures used a fixed 10x6 inch device and were letterboxed until the first resize; both capture sites now size the device from the viewer panel dimensions.
- **Hover-inspect alignment** - the overlay mapped the whole img element box instead of the letterboxed content rect, so snap rings landed slightly off and projection lines ran past the panel; mouse mapping and drawing now use the drawn content rect.
- **Hover stays aligned after resize** - resize re-renders now re-read the coordinate transform (panel fractions depend on device size) and forward it to the webview.
- **Consecutive ggplots no longer collapse into one gallery entry** on ggplot2 4.x (grid.newpage is now traced as the grid equivalent of plot.new).
- **Single-point plots snap correctly** - a lone point was serialized as a JSON scalar and silently disabled snapping.
- **Point buffer overshoot** - one oversized draw past the 5000-point cap dropped the whole snap set; it is truncated instead.
- **Trace hygiene** - stopping the viewer now untraces plot.xy, grid.newpage and set_last_plot as well.

### Under the hood
- The hook-content unit tests now exercise the production .Rprofile hook string (including the interactive() guard).
- Duplicate CSS rules cleaned up; inspect overlay sized from the same rect the mouse handlers use, with a null-guarded 2d context.

## v0.50.0 - Interactive inspect: hover read-out, point snapping, measure and zoom

### New
- **Hover to inspect** - hover a static base-graphics plot to read the data coordinates under the cursor. The R server captures each plot's coordinate transform (axis limits, panel position, log scales) and the webview maps a pixel back to data space, with a crosshair and dashed axis-projection lines.
- **Nearest-point snapping** - the server traces the actual plotted data points (via graphics::plot.xy) so hover snaps to the closest real point and shows its exact value, ringed to distinguish it from the free cursor.
- **Measure tool** - click two points to get delta-x, delta-y and the distance in data units.
- **Zoom to region** - drag a rectangle on the plot to generate an xlim/ylim command and type it into the R console.
- **Grid / montage export** - combine several plots (favourites, or the gallery) into one grid PNG for reports.
- **Plot card export** - composite a plot with its generating code (lightly syntax-coloured) and note into one shareable PNG.
- **Copy reproducible snippet** - copy a self-contained block (source header + code + note) for issues or a reprex.
- **Settings menu** - a toolbar gear to toggle hover-inspect and switch inspect tools.

### Under the hood
- The webview entry (main.ts) is type-checked in CI with the strict-family flags it already passes, catching more bugs at compile time.

## v0.49.0 - Diff view, code/plot linking, richer copy & theme-aware viewer

### New
- **Pixel diff view** - a new Diff toolbar button overlays two plots and highlights the pixels that changed (magenta), so you can see exactly how a plot moved when you tweaked the code or parameters. Doubles as a quick regression check. Picks the pair from the Split View selection, or the current plot vs the previous one, with a sensitivity slider and a changed-pixel percentage.
- **Reverse code to plot link** - moving the cursor in an R/Julia file now glows the gallery thumbnails whose captured source covers that line, the mirror of the existing plot to source jump.
- **Copy as PNG or SVG** - the Copy button is now a dropdown: copy the plot as a PNG raster, or copy the raw SVG vector markup as text to paste into Illustrator, Inkscape or Figma (vector plots only).
- **Keyboard shortcuts** - in the viewer: arrows for previous/next, `a` annotate, `e` export, `d` dark mode, `Esc` to leave annotation. Plus editor keybindings scoped to the view (alt+left/right, ctrl/cmd+alt+e, ctrl/cmd+alt+a).

### Improved
- **Theme-aware viewer** - the dark (inverted) plot mode now follows the VS Code color theme by default and live-updates when you switch themes; a manual toggle pins it for the session.
- **Per-plot zoom** - each plot remembers its own zoom level instead of sharing one global setting.
- **Annotation badges** - annotated plots show a marker in the gallery, and annotations remain baked into every export (PNG, SVG, PDF and clipboard).

### Under the hood
- **Webview migrated to TypeScript** - the ~2700-line webview script is now a bundled TypeScript entry that imports the typed, unit-tested core modules directly, and is type-checked in CI to catch a whole class of bugs at compile time.
- **Fix** - the annotation tools (pencil/arrow/text) briefly broke after the bundle switch because of a strict-mode regression; fixed and guarded against recurrence.

## v0.48.0 - Remote, exports, gallery archive, code actions & reliable attach

### New
- **Remote-SSH / WSL / Dev Containers / Codespaces support (#5)** - the webview now reaches the R WebSocket server on a remote host via `asExternalUri` port forwarding (with `ws:`/`wss:` CSP), instead of a loopback address that never connects.
- **Export presets** - PNG (Screen 1x, High DPI 2x, Publication 3x), PNG/PDF Slide 16:9 (1920×1080), and SVG. New offline **PDF export** (bundled jsPDF, no runtime dependency).
- **Offline gallery archive** - plot images + metadata are saved to disk, so the gallery survives an R-session shutdown or a VS Code restart.
- **Durable favorites & notes** - persisted to workspace storage and restored by plot id.
- **Per-plot code actions** - a toolbar Code menu: Copy Code, Reveal Code in Console, Run Code Again, Open Source File. The R server captures the originating expression (deparse + srcref).
- **Report Issue command** - opens a prefilled GitHub issue with environment info and the recent log.
- **Configurable port range** - `rPlotViewer.minPort` / `maxPort` for strict firewalls.
- **Force-attach command** - “R Plot Pro: Attach to Terminal” for pre-existing or unrecognised terminals.

### Reliability
- **Julia startup.jl hook** - mirrors the R `.Rprofile` hook so Julia auto-captures at startup with no timing gap (offered lazily on first Julia use).
- **Shell-integration launch detection** - detects an interactive R/Julia launch by the actual command (not the terminal name) and injects on a clean prompt.
- **Event-driven sentinel** - polls terminals only after activity, then stops (idle CPU drops to zero).
- **Fixes** - escaped a regex bug that made startup-hook removal a silent no-op; guarded Julia against double-server-start.

### Engineering
- Single-source version (`scripts/sync-version.js`), structured logging + Output channel, GitHub Actions CI (Linux/macOS/Windows), and a typed, unit-tested webview core (esbuild) for the reconnect + gallery-merge logic. 45 automated tests.

## v0.47.0 - Windows, remote and connection fixes

**Resolves the open Windows / remote / connection issues (#3, #4, #5, #6).**

### Bug Fixes
- **Activation on machines without the Julia extension (#4)** - `julialang.language-julia` was a hard `extensionDependencies` entry, so VS Code refused to activate the extension for anyone who did not have it installed, leaving commands like `rPlotViewer.showPlot` unregistered. Julia support is now optional; only the R extension is required.
- **`/tmp/rplot_debug.log` warnings on Windows and remote backends (#5, #6)** - the R server hardcoded the debug-log path to `/tmp` and only caught errors, not warnings, so `file()` failing surfaced `cannot open file '/tmp/rplot_debug.log'` on every plot. The log now lives under `tempdir()` and writes are fully warning-safe.
- **Connection drops to "Offline" and never recovers (#3)** - the webview now auto-reconnects to a dropped-but-still-live backend (linear backoff, capped, sticky give-up), instead of staying offline until R is restarted.
- **Unix-only port recovery** - the "address already in use" fallback used `lsof`/`kill`; it now runs those only on Unix and otherwise retries on a fresh port, rewriting the config so the extension reconnects.

## v0.46.0 - Positron-Grade Multi-Plot Capture

**The most reliable R plot capture engine yet - matches Positron behavior exactly.**

### Bug Fixes
- **First-run single-plot capture** - `installed.packages()` was failing silently during `.Rprofile` startup (utils not yet attached), aborting init.R before the source patch was installed. Replaced with `requireNamespace()`, which is always available at R startup.
- **Multi-panel plots as single frame** - `pairs()`, `layout()`, `par(mfrow=...)` and any function calling `plot.new()` internally no longer produce partial intermediate captures. The `plot.new` tracer now only sets a flag; capture happens once per expression after it completes - identical to Positron's execution loop.
- **Additive draw functions update in-place** - `qqline()`, `lines()`, `points()`, `legend()`, `abline()` now update the last plot entry instead of creating a new one. `qqnorm()` + `qqline()` = 1 plot, not 2.

### New
- Julia 20-plot test suite (`test_multi_plot.jl`) covering scatter, line, histogram, heatmap, contour, 3D surface/scatter, subplots and more - no StatsPlots required.

---

## v0.45.0 - Universal Capture Engine & GIS Stability

- **Universal Plot Capture:** Re-enabled and optimized throttled task callbacks. Captures ALL plot types (Base R, Lattice, Maps) in addition to ggplot2.
- **Invisible Background Rendering:** Non-focus-stealing PDF null device. No external OS windows (Quartz/X11) during analysis.
- **GIS & Heavy Data Optimization:** Tuned for memory-intensive packages like `terra`, `sf`, `blackmarbler`.
- **Manual Capture Helper:** `.vsc_rplot$capture()` to force a plot refresh.
- **Robust ggplot2 Tracing:** Fixed namespace conflict preventing ggplot2 capture in some environments.
- **Performance Throttling:** Smart 500ms refresh window to prevent UI freezing during rapid plotting.
- **`.Rprofile` Integration:** Zero-timing-gap capture via `RPLOT_PRO_INIT` env var and `environmentVariableCollection`.
- **Version-based re-init guard:** Sentinel injection skips re-init on same version, reloads on new version.
- **Stale port file cleanup:** Clears leftover `.json` config files on activation to prevent offline extension issues.

---

## v0.40.0 - Registry Distinction

- Overhauled README header to separate VS Code Marketplace and Open VSX Registry platforms.
- Integrated live download counts from Open VSX.
- Stable static badges for VS Code Marketplace.

---

## v0.39.0 - Onboarding & Ecosystem Integration

- Added `julialang.language-julia` as a formal extension dependency.
- Redesigned README with detailed setup guide for R and Julia.
- Terminal profile configuration guide.
- Sentinel system transparency documentation.

---

## v0.38.0 - Internal Mirror Protocol

- Internal ANSI wipe logic in `init.R` and `init.jl`.
- 100% native R/Julia banner preservation.
- Nano-path optimization using `/tmp` on Unix.
- Fixed R/Julia terminal cross-injection bug.

---

## v0.32.0 - Phantom Mirror Stealth (Full Julia Support)

- Full Julia support: CairoMakie and Plots.jl (GR).
- Intercepts all `display()` calls, suppresses external windows.
- Trace-free terminal initialization for R and Julia.
- ANSI terminal buffer wipe for clean terminal output.

---

## v0.0.1 - Initial Release

- Real-time plot visualization in VS Code panel.
- Plot gallery with thumbnails, favorites, notes.
- Drag-and-drop export, zoom, aspect ratio controls.
- Dark mode support.
