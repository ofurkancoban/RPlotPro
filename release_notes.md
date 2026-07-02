# R Plot Pro — Release Notes

## v0.48.0 — Remote, exports, gallery archive, code actions & reliable attach

### New
- **Remote-SSH / WSL / Dev Containers / Codespaces support (#5)** — the webview now reaches the R WebSocket server on a remote host via `asExternalUri` port forwarding (with `ws:`/`wss:` CSP), instead of a loopback address that never connects.
- **Export presets** — PNG (Screen 1x, High DPI 2x, Publication 3x), PNG/PDF Slide 16:9 (1920×1080), and SVG. New offline **PDF export** (bundled jsPDF, no runtime dependency).
- **Offline gallery archive** — plot images + metadata are saved to disk, so the gallery survives an R-session shutdown or a VS Code restart.
- **Durable favorites & notes** — persisted to workspace storage and restored by plot id.
- **Per-plot code actions** — a toolbar Code menu: Copy Code, Reveal Code in Console, Run Code Again, Open Source File. The R server captures the originating expression (deparse + srcref).
- **Report Issue command** — opens a prefilled GitHub issue with environment info and the recent log.
- **Configurable port range** — `rPlotViewer.minPort` / `maxPort` for strict firewalls.
- **Force-attach command** — “R Plot Pro: Attach to Terminal” for pre-existing or unrecognised terminals.

### Reliability
- **Julia startup.jl hook** — mirrors the R `.Rprofile` hook so Julia auto-captures at startup with no timing gap (offered lazily on first Julia use).
- **Shell-integration launch detection** — detects an interactive R/Julia launch by the actual command (not the terminal name) and injects on a clean prompt.
- **Event-driven sentinel** — polls terminals only after activity, then stops (idle CPU drops to zero).
- **Fixes** — escaped a regex bug that made startup-hook removal a silent no-op; guarded Julia against double-server-start.

### Engineering
- Single-source version (`scripts/sync-version.js`), structured logging + Output channel, GitHub Actions CI (Linux/macOS/Windows), and a typed, unit-tested webview core (esbuild) for the reconnect + gallery-merge logic. 45 automated tests.

## v0.47.0 — Windows, remote and connection fixes

**Resolves the open Windows / remote / connection issues (#3, #4, #5, #6).**

### Bug Fixes
- **Activation on machines without the Julia extension (#4)** — `julialang.language-julia` was a hard `extensionDependencies` entry, so VS Code refused to activate the extension for anyone who did not have it installed, leaving commands like `rPlotViewer.showPlot` unregistered. Julia support is now optional; only the R extension is required.
- **`/tmp/rplot_debug.log` warnings on Windows and remote backends (#5, #6)** — the R server hardcoded the debug-log path to `/tmp` and only caught errors, not warnings, so `file()` failing surfaced `cannot open file '/tmp/rplot_debug.log'` on every plot. The log now lives under `tempdir()` and writes are fully warning-safe.
- **Connection drops to "Offline" and never recovers (#3)** — the webview now auto-reconnects to a dropped-but-still-live backend (linear backoff, capped, sticky give-up), instead of staying offline until R is restarted.
- **Unix-only port recovery** — the "address already in use" fallback used `lsof`/`kill`; it now runs those only on Unix and otherwise retries on a fresh port, rewriting the config so the extension reconnects.

## v0.46.0 — Positron-Grade Multi-Plot Capture

**The most reliable R plot capture engine yet — matches Positron behavior exactly.**

### Bug Fixes
- **First-run single-plot capture** — `installed.packages()` was failing silently during `.Rprofile` startup (utils not yet attached), aborting init.R before the source patch was installed. Replaced with `requireNamespace()`, which is always available at R startup.
- **Multi-panel plots as single frame** — `pairs()`, `layout()`, `par(mfrow=...)` and any function calling `plot.new()` internally no longer produce partial intermediate captures. The `plot.new` tracer now only sets a flag; capture happens once per expression after it completes — identical to Positron's execution loop.
- **Additive draw functions update in-place** — `qqline()`, `lines()`, `points()`, `legend()`, `abline()` now update the last plot entry instead of creating a new one. `qqnorm()` + `qqline()` = 1 plot, not 2.

### New
- Julia 20-plot test suite (`test_multi_plot.jl`) covering scatter, line, histogram, heatmap, contour, 3D surface/scatter, subplots and more — no StatsPlots required.

---

## v0.45.0 — Universal Capture Engine & GIS Stability

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

## v0.40.0 — Registry Distinction

- Overhauled README header to separate VS Code Marketplace and Open VSX Registry platforms.
- Integrated live download counts from Open VSX.
- Stable static badges for VS Code Marketplace.

---

## v0.39.0 — Onboarding & Ecosystem Integration

- Added `julialang.language-julia` as a formal extension dependency.
- Redesigned README with detailed setup guide for R and Julia.
- Terminal profile configuration guide.
- Sentinel system transparency documentation.

---

## v0.38.0 — Internal Mirror Protocol

- Internal ANSI wipe logic in `init.R` and `init.jl`.
- 100% native R/Julia banner preservation.
- Nano-path optimization using `/tmp` on Unix.
- Fixed R/Julia terminal cross-injection bug.

---

## v0.32.0 — Phantom Mirror Stealth (Full Julia Support)

- Full Julia support: CairoMakie and Plots.jl (GR).
- Intercepts all `display()` calls, suppresses external windows.
- Trace-free terminal initialization for R and Julia.
- ANSI terminal buffer wipe for clean terminal output.

---

## v0.0.1 — Initial Release

- Real-time plot visualization in VS Code panel.
- Plot gallery with thumbnails, favorites, notes.
- Drag-and-drop export, zoom, aspect ratio controls.
- Dark mode support.
