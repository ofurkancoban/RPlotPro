"use strict";
(() => {
  // webview/src/reconnect.ts
  var ReconnectManager = class {
    constructor(opts) {
      this.opts = opts;
      this.timers = /* @__PURE__ */ new Map();
      this.attempts = /* @__PURE__ */ new Map();
      this.max = opts.maxReconnect ?? 8;
      this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
      this.clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
    }
    /** Linear backoff, capped at 5s. Exposed for testing. */
    delay(attempt) {
      return Math.min(1e3 * attempt, 5e3);
    }
    /** Cancel any pending reconnect for a port and reset its attempt counter. */
    clear(port) {
      port = Number(port);
      const t = this.timers.get(port);
      if (t !== void 0) {
        this.clearT(t);
        this.timers.delete(port);
      }
      this.attempts.delete(port);
    }
    /**
     * Schedule a reconnect to a dropped port unless it is no longer wanted or the
     * attempt budget is exhausted. Sticky give-up: once over budget the counter is
     * kept above it so repeated close events do not restart the cycle; it is reset
     * only by clear() (a successful connect) or a fresh discovery.
     */
    schedule(port) {
      port = Number(port);
      if (this.timers.has(port)) return;
      if (!this.opts.isDesired(port)) return;
      const n = (this.attempts.get(port) || 0) + 1;
      if (n > this.max) {
        this.opts.log?.(`Giving up reconnect to port ${port}`);
        this.attempts.set(port, n);
        return;
      }
      this.attempts.set(port, n);
      const delay = this.delay(n);
      this.opts.log?.(`Reconnecting to port ${port} in ${delay}ms (attempt ${n}/${this.max})`);
      const t = this.setT(() => {
        this.timers.delete(port);
        if (this.opts.isDesired(port) && !this.opts.isActive(port)) {
          this.opts.connect(port);
        }
      }, delay);
      this.timers.set(port, t);
    }
    // --- inspection helpers (used by tests) ---
    hasTimer(port) {
      return this.timers.has(Number(port));
    }
    attemptCount(port) {
      return this.attempts.get(Number(port)) || 0;
    }
  };

  // webview/src/archive.ts
  function idNum(id) {
    return Number(String(id).replace(/^[a-z]+-/i, "")) || 0;
  }
  function mergePlotLists(existing, incoming, port) {
    const otherPlots = existing.filter((p) => p.port && p.port !== port);
    const taggedIncoming = incoming.map((np) => ({ ...np, port }));
    const byId = /* @__PURE__ */ new Map();
    for (const p of [...otherPlots, ...taggedIncoming]) {
      const key = String(p.id);
      const prev = byId.get(key);
      if (!prev || prev.port === "archive" && p.port !== "archive") {
        byId.set(key, p);
      }
    }
    return Array.from(byId.values()).sort((a, b) => idNum(a.id) - idNum(b.id));
  }

  // webview/src/geometry.ts
  function aspectRatio(aspect) {
    if (aspect === "square") return 1;
    if (aspect === "landscape") return 4 / 3;
    if (aspect === "portrait") return 3 / 4;
    return 0;
  }
  function computePlotDimensions(zoom, aspect, containerW, containerH) {
    const ratio = aspectRatio(aspect);
    let fitW;
    let fitH;
    if (ratio === 0) {
      fitW = containerW;
      fitH = containerH;
    } else if (containerW / containerH > ratio) {
      fitH = containerH;
      fitW = containerH * ratio;
    } else {
      fitW = containerW;
      fitH = containerW / ratio;
    }
    let width;
    let height;
    if (zoom === "fit") {
      width = fitW;
      height = fitH;
    } else {
      const factor = parseInt(String(zoom), 10) / 100;
      width = fitW * factor;
      height = fitH * factor;
    }
    return { width, height, fitsW: width <= containerW, fitsH: height <= containerH };
  }
  function computeExportCanvas(natW, natH, opts = {}) {
    if (opts.width && opts.height) {
      const cw2 = opts.width;
      const ch2 = opts.height;
      const r = Math.min(cw2 / natW, ch2 / natH);
      const dw = natW * r;
      const dh = natH * r;
      return { cw: cw2, ch: ch2, dx: (cw2 - dw) / 2, dy: (ch2 - dh) / 2, dw, dh };
    }
    const scale = opts.scale || 2;
    const cw = natW * scale;
    const ch = natH * scale;
    return { cw, ch, dx: 0, dy: 0, dw: cw, dh: ch };
  }
  function paletteScale(containerW, containerH) {
    if (containerW < 400 || containerH < 400) {
      return Math.max(0.6, Math.min(containerW / 500, containerH / 500));
    }
    return 1;
  }
  function computeGridLayout(n, cellW, cellH, gap = 12) {
    const count = Math.max(0, Math.floor(n));
    const cols = count > 0 ? Math.ceil(Math.sqrt(count)) : 0;
    const rows = cols > 0 ? Math.ceil(count / cols) : 0;
    const cells = [];
    for (let i = 0; i < count; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      cells.push({ x: gap + c * (cellW + gap), y: gap + r * (cellH + gap), w: cellW, h: cellH });
    }
    return {
      cols,
      rows,
      canvasW: cols > 0 ? cols * cellW + (cols + 1) * gap : 0,
      canvasH: rows > 0 ? rows * cellH + (rows + 1) * gap : 0,
      cells
    };
  }
  function computeSplitCanvas(natWL, natHL, natWR, natHR, scale = 2) {
    const wL = (natWL || 800) * scale;
    const hL = (natHL || 600) * scale;
    const wR = (natWR || 800) * scale;
    const hR = (natHR || 600) * scale;
    const canvasW = wL + wR;
    const canvasH = Math.max(hL, hR);
    return {
      canvasW,
      canvasH,
      left: { x: 0, y: (canvasH - hL) / 2, w: wL, h: hL },
      right: { x: wL, y: (canvasH - hR) / 2, w: wR, h: hR }
    };
  }

  // webview/src/annotation.ts
  function toCanvasCoords(clientX, clientY, rect, canvasW, canvasH) {
    return {
      x: (clientX - rect.left) * (canvasW / rect.width),
      y: (clientY - rect.top) * (canvasH / rect.height)
    };
  }
  function arrowGeometry(fromX, fromY, toX, toY, headLength = 20, tipInset = 5) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headAngle = Math.PI / 6;
    return {
      angle,
      lineEndX: toX - tipInset * Math.cos(angle),
      lineEndY: toY - tipInset * Math.sin(angle),
      tipX: toX,
      tipY: toY,
      leftX: toX - headLength * Math.cos(angle - headAngle),
      leftY: toY - headLength * Math.sin(angle - headAngle),
      rightX: toX - headLength * Math.cos(angle + headAngle),
      rightY: toY - headLength * Math.sin(angle + headAngle)
    };
  }

  // webview/src/history.ts
  var AnnotationHistory = class {
    constructor(limit = 30) {
      this.limit = limit;
      this.map = /* @__PURE__ */ new Map();
    }
    get(pid) {
      const key = String(pid);
      let s = this.map.get(key);
      if (!s) {
        s = { undo: [], redo: [] };
        this.map.set(key, s);
      }
      return s;
    }
    canUndo(pid) {
      return this.get(pid).undo.length > 0;
    }
    canRedo(pid) {
      return this.get(pid).redo.length > 0;
    }
    // Record a new committed state: push the previous snapshot onto the undo stack
    // (bounded by `limit`) and clear the redo stack (a new action forks history).
    commit(pid, previousState) {
      const s = this.get(pid);
      s.undo.push(previousState);
      if (s.undo.length > this.limit) s.undo.shift();
      s.redo = [];
    }
    // Undo: caller passes the current snapshot (pushed to redo). Returns the snapshot
    // to render, or null if there is nothing to undo.
    undo(pid, currentState) {
      const s = this.get(pid);
      if (s.undo.length === 0) return null;
      s.redo.push(currentState);
      return s.undo.pop() ?? null;
    }
    // Redo: mirror of undo.
    redo(pid, currentState) {
      const s = this.get(pid);
      if (s.redo.length === 0) return null;
      s.undo.push(currentState);
      return s.redo.pop() ?? null;
    }
    clear(pid) {
      if (pid === void 0) this.map.clear();
      else this.map.delete(String(pid));
    }
  };

  // webview/src/format.ts
  function sniffImageMime(headText, metadataFormat, byteLength = 0) {
    let mime = metadataFormat === "svg" ? "image/svg+xml" : "image/png";
    if (byteLength > 10) {
      mime = headText.includes("<svg") || headText.includes("<?xml") ? "image/svg+xml" : "image/png";
    }
    return mime;
  }

  // webview/src/diff.ts
  function diffPixels(a, b, opts = {}) {
    const threshold = opts.threshold ?? 0;
    const hi = opts.highlight ?? [255, 0, 255];
    const fade = opts.fade ?? 0.2;
    const len = Math.min(a.length, b.length);
    const out = new Uint8ClampedArray(len);
    let changed = 0;
    for (let i = 0; i < len; i += 4) {
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      if (dr > threshold || dg > threshold || db > threshold) {
        out[i] = hi[0];
        out[i + 1] = hi[1];
        out[i + 2] = hi[2];
        out[i + 3] = 255;
        changed++;
      } else {
        const gray = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
        const v = 255 - (255 - gray) * fade;
        out[i] = v;
        out[i + 1] = v;
        out[i + 2] = v;
        out[i + 3] = 255;
      }
    }
    return { out, changed, total: Math.floor(len / 4) };
  }

  // webview/src/inspect.ts
  function dataAtPixel(px, py, w, h, c) {
    if (!c || !c.usr || !c.plt || w <= 0 || h <= 0) return null;
    const fx = px / w;
    const fyBottom = 1 - py / h;
    const [l, r, b, t] = c.plt;
    if (fx < l || fx > r || fyBottom < b || fyBottom > t) return null;
    const xf = (fx - l) / (r - l);
    const yf = (fyBottom - b) / (t - b);
    const [x1, x2, y1, y2] = c.usr;
    let x = x1 + xf * (x2 - x1);
    let y = y1 + yf * (y2 - y1);
    if (c.xlog) x = Math.pow(10, x);
    if (c.ylog) y = Math.pow(10, y);
    return { x, y };
  }
  function panelPixelRect(w, h, c) {
    if (!c || !c.plt || w <= 0 || h <= 0) return null;
    const [l, r, b, t] = c.plt;
    return {
      left: l * w,
      right: r * w,
      top: (1 - t) * h,
      // plt top is a fraction from the bottom; pixels grow downward
      bottom: (1 - b) * h
    };
  }
  function formatInspectValue(v) {
    if (!isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
    return String(Number(v.toPrecision(5)));
  }

  // webview/src/main.ts
  var vscode = acquireVsCodeApi();
  var plots = [];
  var state = vscode.getState() || {};
  var currentIndex = typeof state.currentIndex === "number" ? state.currentIndex : -1;
  var showOnlyFavorites = false;
  var currentNoteIndex = -1;
  var plotUrls = /* @__PURE__ */ new Map();
  var savedMetaMap = /* @__PURE__ */ new Map();
  function applyRestoredMeta(meta) {
    savedMetaMap = new Map((meta || []).map((m) => [m.id, { note: m.note || "", isFavorite: !!m.isFavorite }]));
    plots.forEach((p) => {
      const m = savedMetaMap.get(p.id);
      if (m) {
        p.note = m.note;
        p.isFavorite = m.isFavorite;
      }
    });
    updatePlotList();
  }
  function persistMeta() {
    const meta = plots.map((p) => ({ id: p.id, note: p.note || "", isFavorite: !!p.isFavorite }));
    savedMetaMap = new Map(meta.map((m) => [m.id, { note: m.note, isFavorite: m.isFavorite }]));
    vscode.postMessage({ command: "persist_meta", meta });
  }
  var ARCHIVE_MAX = 60;
  var archiveTimer = null;
  function dataURLToBlob(dataURL) {
    const [head, b64] = String(dataURL).split(",");
    const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/png";
    const bin = atob(b64 || "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  async function blobUrlToDataURL(url) {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return await new Promise((res) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.onerror = () => res(null);
        r.readAsDataURL(blob);
      });
    } catch (_) {
      return null;
    }
  }
  function persistArchive() {
    if (archiveTimer) clearTimeout(archiveTimer);
    archiveTimer = setTimeout(async () => {
      archiveTimer = null;
      try {
        const recent = plots.slice(-ARCHIVE_MAX);
        const out = [];
        for (const p of recent) {
          let data = null;
          const url = plotUrls.get(p.id);
          if (url) data = await blobUrlToDataURL(url);
          else if (p.data && String(p.data).startsWith("data:")) data = p.data;
          if (!data) continue;
          out.push({
            id: p.id,
            data,
            format: p.format || "png",
            timestamp: p.timestamp || "",
            note: p.note || "",
            isFavorite: !!p.isFavorite,
            code: p.code || "",
            srcFile: p.srcFile || "",
            srcLine1: p.srcLine1,
            srcLine2: p.srcLine2
          });
        }
        vscode.postMessage({ command: "persist_archive", plots: out });
      } catch (e) {
        log("persistArchive failed: " + e);
      }
    }, 1500);
  }
  function applyRestoredArchive(archived) {
    if (!archived || !archived.length) return;
    let added = false;
    for (const a of archived) {
      if (!a || !a.id || !a.data) continue;
      if (plots.some((p) => String(p.id) === String(a.id))) continue;
      try {
        const url = URL.createObjectURL(dataURLToBlob(a.data));
        plotUrls.set(a.id, url);
        const meta = savedMetaMap.get(a.id);
        plots.push({
          id: a.id,
          data: url,
          format: a.format || "png",
          timestamp: a.timestamp || "",
          note: (meta ? meta.note : a.note) || "",
          isFavorite: meta ? meta.isFavorite : !!a.isFavorite,
          code: a.code || "",
          srcFile: a.srcFile || "",
          srcLine1: a.srcLine1,
          srcLine2: a.srcLine2,
          port: "archive"
        });
        added = true;
      } catch (e) {
        log("restore archive item failed: " + e);
      }
    }
    if (added) {
      const idNum2 = (id) => Number(String(id).replace(/^[a-z]+-/i, "")) || 0;
      plots.sort((x, y) => idNum2(x.id) - idNum2(y.id));
      if (currentIndex < 0 && plots.length) currentIndex = plots.length - 1;
      updatePlotList();
      if (currentIndex >= 0) showPlot(currentIndex, false);
    }
  }
  var thumbObserver;
  var isSplitMode = false;
  var leftIndex = typeof state.leftIndex === "number" ? state.leftIndex : -1;
  var rightIndex = typeof state.rightIndex === "number" ? state.rightIndex : -1;
  var isDraggingDivider = false;
  function detectVsCodeDark() {
    const c = document.body.classList;
    return c.contains("vscode-dark") || c.contains("vscode-high-contrast");
  }
  var darkModeUserSet = typeof state.darkMode === "boolean";
  var isDarkMode = darkModeUserSet ? state.darkMode : detectVsCodeDark();
  var hoverInspectEnabled = state.hoverInspect !== false;
  var lastCanvasData = /* @__PURE__ */ new Map();
  var plotZoom = state.plotZoom ? new Map(Object.entries(state.plotZoom)) : /* @__PURE__ */ new Map();
  var isAnnotating = false;
  var currentTool = "pencil";
  var currentColor = "#ff4757";
  var isDrawing = false;
  var activeCanvas = null;
  var activeCtx = null;
  var activePane = "left";
  var paletteState = state.palette || { x: 40, y: 40, isHorizontal: true };
  var annotationHistory = new AnnotationHistory(30);
  if (state.annotations) {
    for (const [id, data] of Object.entries(state.annotations)) {
      lastCanvasData.set(String(id), data);
    }
  }
  function log(msg) {
    console.log("[R Plot]", msg);
    logToUI(msg);
    try {
      vscode.postMessage({ command: "log", text: String(msg) });
    } catch (_) {
    }
  }
  function getZoomFromClass(target) {
    const zoomLevels = ["fit", "50", "75", "100", "200"];
    for (const z of zoomLevels) {
      if (target.classList.contains("zoom-" + z)) return z;
    }
    return "fit";
  }
  function getScaleFromClass(target) {
    const aspectRatios = ["auto", "square", "landscape", "portrait", "fill"];
    for (const a of aspectRatios) {
      if (target.classList.contains("aspect-" + a)) return a;
    }
    return "auto";
  }
  function updatePlotDimensions(wrapperId) {
    const previewWrappers = ["mainMediaWrapper", "leftMediaWrapper", "rightMediaWrapper"];
    if (!previewWrappers.includes(wrapperId)) return;
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper) return;
    const container = wrapper.parentElement;
    if (!container) return;
    const zoom = getZoomFromClass(wrapper);
    const aspect = getScaleFromClass(wrapper);
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw === 0 || ch === 0) return;
    const dims = computePlotDimensions(zoom, aspect, cw, ch);
    const targetW = dims.width;
    const targetH = dims.height;
    wrapper.style.width = Math.floor(targetW) + "px";
    wrapper.style.height = Math.floor(targetH) + "px";
    const fitsW = dims.fitsW;
    const fitsH = dims.fitsH;
    wrapper.style.marginLeft = fitsW ? "auto" : "0";
    wrapper.style.marginRight = fitsW ? "auto" : "0";
    wrapper.style.marginTop = fitsH ? "auto" : "0";
    wrapper.style.marginBottom = fitsH ? "auto" : "0";
    if (fitsW && fitsH) {
      container.scrollLeft = 0;
      container.scrollTop = 0;
      wrapper.style.visibility = "visible";
    } else {
      wrapper.style.visibility = "hidden";
      let attempts = 0;
      const doCenter = () => {
        const _reflow = container.offsetHeight;
        const sw = container.scrollWidth;
        const sh = container.scrollHeight;
        const cw_actual = container.clientWidth;
        const ch_actual = container.clientHeight;
        if (sw > cw_actual) container.scrollLeft = (sw - cw_actual) / 2;
        if (sh > ch_actual) container.scrollTop = (sh - ch_actual) / 2;
        attempts++;
        if (attempts < 15) {
          requestAnimationFrame(doCenter);
        } else {
          wrapper.style.visibility = "visible";
          setTimeout(() => {
            if (sw > cw_actual) container.scrollLeft = (sw - cw_actual) / 2;
            if (sh > ch_actual) container.scrollTop = (sh - ch_actual) / 2;
          }, 350);
        }
      };
      requestAnimationFrame(doCenter);
    }
    if (isAnnotating && activeCanvas && activeCanvas.parentElement === wrapper) {
      setupActiveCanvas();
      updatePaletteScaling();
      const pid = isSplitMode ? wrapperId === "leftMediaWrapper" ? plots[leftIndex]?.id : plots[rightIndex]?.id : plots[currentIndex]?.id;
      if (pid) restoreAnnotation(pid, activeCanvas.id);
    }
  }
  function logToUI(msg) {
    const debugLog = document.getElementById("debugLog");
    if (debugLog) {
      const entry = document.createElement("div");
      entry.textContent = `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${msg}`;
      debugLog.prepend(entry);
      if (debugLog.childNodes.length > 50) debugLog.removeChild(debugLog.lastChild);
    }
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.command) {
      case "set_ports":
        updateConnections(message.backends);
        break;
      case "set_active_file":
        broadcastToBackends({
          type: "set_active_file",
          filePath: message.filePath
        });
        break;
      case "store_active_file":
        const currentState = vscode.getState() || {};
        vscode.setState({ ...currentState, activeFile: message.filePath });
        break;
      case "next_plot":
        nextPlot();
        break;
      case "previous_plot":
        previousPlot();
        break;
      case "clear_plots":
        clearAllPlots();
        break;
      case "export_plot":
        exportPlot();
        break;
      case "do_export":
        exportAsFormat(message.format, message);
        break;
      case "highlight_source":
        highlightPlotsForSource(message.file, message.line);
        break;
      case "toggle_annotation":
        toggleAnnotationMode();
        break;
      case "restore_meta":
        applyRestoredMeta(message.meta);
        break;
      case "restore_archive":
        applyRestoredArchive(message.plots);
        break;
      case "info":
        console.info(message.text);
        break;
    }
  });
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
  var activeSockets = /* @__PURE__ */ new Map();
  var portLanguages = /* @__PURE__ */ new Map();
  var desiredPorts = /* @__PURE__ */ new Map();
  var portUrls = /* @__PURE__ */ new Map();
  var reconnectMgr = new ReconnectManager({
    maxReconnect: 8,
    isDesired: (port) => desiredPorts.has(Number(port)),
    isActive: (port) => activeSockets.has(Number(port)),
    connect: (port) => connectToPort(Number(port), desiredPorts.get(Number(port))),
    log: (msg) => log(msg)
  });
  function clearReconnect(port) {
    reconnectMgr.clear(Number(port));
  }
  function scheduleReconnect(port) {
    reconnectMgr.schedule(Number(port));
  }
  var LOGOS = {
    julia: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M58.3 93.5c0 15.7-12.7 28.3-28.3 28.3-15.7 0-28.3-12.7-28.3-28.3 0-15.6 12.7-28.3 28.3-28.3 15.6-.1 28.3 12.6 28.3 28.3" fill="#cb3c33"/><path d="M30 123.4c-16.5 0-30-13.4-30-30s13.4-30 30-30 30 13.4 30 30-13.5 30-30 30zm0-56.6c-14.7 0-26.7 12-26.7 26.7s12 26.7 26.7 26.7 26.7-12 26.7-26.7-12-26.7-26.7-26.7z" fill="#eee"/><path d="M126.4 93.5c0 15.7-12.7 28.3-28.3 28.3s-28.3-12.7-28.3-28.3c0-15.6 12.7-28.3 28.3-28.3s28.3 12.6 28.3 28.3" fill="#9558b2"/><path d="M98 123.4c-16.5 0-30-13.4-30-30s13.4-30 30-30 30 13.4 30 30-13.4 30-30 30zm0-56.6c-14.7 0-26.7 12-26.7 26.7s12 26.7 26.7 26.7 26.7-12 26.7-26.7S112.8 66.8 98 66.8z" fill="#eee"/><path d="M92.4 34.5c0 15.6-12.7 28.3-28.3 28.3-15.7 0-28.3-12.7-28.3-28.3S48.4 6.2 64 6.2c15.7 0 28.4 12.7 28.4 28.3" fill="#389826"/><path d="M64 64.5c-16.5 0-30-13.4-30-30s13.4-30 30-30 30 13.4 30 30-13.5 30-30 30zm0-56.7c-14.7 0-26.7 12-26.7 26.7s12 26.7 26.7 26.7 26.7-12 26.7-26.7S78.7 7.8 64 7.8z" fill="#eee"/></svg>`,
    r: `<svg preserveAspectRatio="xMidYMid" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><path d="M64 100.38c-35.346 0-64-19.19-64-42.863 0-23.672 28.654-42.863 64-42.863s64 19.19 64 42.863c0 23.672-28.654 42.863-64 42.863zm9.796-68.967c-26.866 0-48.646 13.119-48.646 29.303 0 16.183 21.78 29.303 48.646 29.303s46.693-8.97 46.693-29.303c0-20.327-19.827-29.303-46.693-29.303z" fill="#a0a1a5" fill-rule="evenodd"/><path d="M97.469 81.033s3.874 1.169 6.124 2.308c.78.395 2.132 1.183 3.106 2.219a8.388 8.388 0 011.42 2.04l15.266 25.74-24.674.01-11.537-21.666s-2.363-4.06-3.817-5.237c-1.213-.982-1.73-1.331-2.929-1.331h-5.862l.004 28.219-21.833.009V41.26h43.844s19.97.36 19.97 19.359c0 18.999-19.082 20.413-19.082 20.413zm-9.497-24.137l-13.218-.009-.006 12.258 13.224-.005s6.124-.019 6.124-6.235c0-6.34-6.124-6.009-6.124-6.009z" fill="#1f65b7" fill-rule="evenodd"/></svg>`
  };
  function updateConnections(backends) {
    if (!backends) return;
    const ports = backends.map((b) => Number(b.port));
    desiredPorts.clear();
    for (const b of backends) {
      desiredPorts.set(Number(b.port), b.language);
      if (b.wsUrl) portUrls.set(Number(b.port), b.wsUrl);
    }
    for (const [port, socket] of activeSockets) {
      if (!ports.includes(Number(port))) {
        log(`Closing connection to port ${port}`);
        socket._intentionalClose = true;
        clearReconnect(port);
        socket.close();
        activeSockets.delete(port);
        portLanguages.delete(port);
        portUrls.delete(port);
      }
    }
    for (const backend of backends) {
      const port = Number(backend.port);
      const lang = backend.language;
      if (!activeSockets.has(port)) {
        connectToPort(port, lang);
      } else if (lang && !portLanguages.has(port)) {
        portLanguages.set(port, lang);
        updateConnectionStatus(true);
      }
    }
    updateConnectionStatus(activeSockets.size > 0);
  }
  function broadcastToBackends(data, targetPort = null) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    if (targetPort && activeSockets.has(Number(targetPort))) {
      const socket = activeSockets.get(Number(targetPort));
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
        return;
      }
    }
    for (const socket of activeSockets.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }
  function connectToPort(port, language) {
    const url = portUrls.get(Number(port)) || "ws://127.0.0.1:" + port;
    log(`Connecting to ${url}...`);
    try {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      let heartbeat;
      let p = port;
      let lang = language;
      socket.onopen = () => {
        log(`Connected to port ${p}`);
        clearReconnect(p);
        activeSockets.set(p, socket);
        if (lang) portLanguages.set(p, lang);
        updateConnectionStatus(true);
        socket.send(JSON.stringify({ type: "get_plots" }));
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
          }
        }, 3e4);
        const activeFile = (vscode.getState() || {}).activeFile;
        if (activeFile) {
          socket.send(JSON.stringify({
            type: "set_active_file",
            filePath: activeFile
          }));
        }
        setTimeout(() => {
          refreshLayout();
          sendResizeEvent();
        }, 150);
      };
      socket.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        activeSockets.delete(p);
        portLanguages.delete(p);
        updateConnectionStatus(activeSockets.size > 0);
        log(`Closed port ${p}`);
        if (!socket._intentionalClose) scheduleReconnect(p);
      };
      socket.onerror = (e) => {
        if (heartbeat) clearInterval(heartbeat);
        activeSockets.delete(p);
        portLanguages.delete(p);
        updateConnectionStatus(activeSockets.size > 0);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "pong") return;
            handleMessage(data, p);
          } catch (e) {
          }
        } else {
          handleBinaryMessage(event.data, p);
        }
      };
    } catch (e) {
      log(`Failed connection to ${port}: ${e.message}`);
    }
  }
  function handleBinaryMessage(buffer, port) {
    try {
      log(`Binary Data Received: ${buffer.byteLength} bytes`);
      if (buffer.byteLength < 4) {
        log("Error: Buffer too small");
        return;
      }
      const view = new DataView(buffer);
      const metaLen = view.getUint32(0, false);
      log(`Meta Length: ${metaLen}`);
      if (buffer.byteLength < 4 + metaLen) {
        log(`Error: Truncated buffer (${buffer.byteLength} < ${4 + metaLen})`);
        return;
      }
      const decoder = new TextDecoder();
      const metaBytes = new Uint8Array(buffer, 4, metaLen);
      const metaJson = decoder.decode(metaBytes);
      const metadata = JSON.parse(metaJson);
      const pid = metadata.id ? String(metadata.id) : null;
      const payload = new Uint8Array(buffer, 4 + metaLen);
      log(`Payload length: ${payload.byteLength} bytes`);
      const sniff = payload.byteLength > 10 ? new TextDecoder().decode(payload.slice(0, 50)) : "";
      const mimeType = sniffImageMime(sniff, metadata.format, payload.byteLength);
      log(`Sniffed format: ${mimeType}`);
      const blob = new Blob([payload], { type: mimeType });
      const url = URL.createObjectURL(blob);
      if (pid && plotUrls.has(pid)) {
        URL.revokeObjectURL(plotUrls.get(pid));
      }
      if (pid) plotUrls.set(pid, url);
      if (metadata.type === "new_plot") {
        addPlot(url, metadata, port);
      } else {
        updateCurrentPlot(pid, url, port, metadata.coords);
      }
    } catch (e) {
      log("CRITICAL ERROR: " + e);
      const statusText = document.getElementById("statusText");
      if (statusText) statusText.textContent = "Data Error";
    }
  }
  function initThumbObserver() {
    if (!thumbObserver) {
      thumbObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const img = entry.target;
            const pid = img.getAttribute("data-id");
            if (pid && !plotUrls.has(pid)) {
              broadcastToBackends({ type: "request_binary", plot_id: pid });
            }
            thumbObserver.unobserve(img);
          }
        });
      }, { root: document.getElementById("plotList"), threshold: 0.1 });
    }
    document.querySelectorAll(".lazy-thumb").forEach((img) => {
      const pid = img.getAttribute("data-id");
      if (plotUrls.has(pid)) {
        img.src = plotUrls.get(pid);
      } else {
        log("Requesting binary for lazy thumb: " + pid);
        thumbObserver.observe(img);
      }
    });
  }
  (function() {
    const container = document.getElementById("plotContainer");
    let isDragging = false;
    let startX2, startY2, scrollLeft, scrollTop;
    container.addEventListener("mousedown", (e) => {
      if (container.scrollWidth > container.clientWidth || container.scrollHeight > container.clientHeight) {
        isDragging = true;
        container.classList.add("dragging");
        startX2 = e.pageX - container.offsetLeft;
        startY2 = e.pageY - container.offsetTop;
        scrollLeft = container.scrollLeft;
        scrollTop = container.scrollTop;
      }
    });
    container.addEventListener("mouseleave", () => {
      isDragging = false;
      container.classList.remove("dragging");
    });
    container.addEventListener("mouseup", () => {
      isDragging = false;
      container.classList.remove("dragging");
    });
    container.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      e.preventDefault();
      const x = e.pageX - container.offsetLeft;
      const y = e.pageY - container.offsetTop;
      const walkX = (x - startX2) * 1.5;
      const walkY = (y - startY2) * 1.5;
      container.scrollLeft = scrollLeft - walkX;
      container.scrollTop = scrollTop - walkY;
    });
  })();
  function handleMessage(data, port) {
    switch (data.type) {
      case "new_plot":
        addPlot(data.data, data.metadata, port);
        break;
      case "update_plot":
        if (data.id && data.data) updateCurrentPlot(data.id, data.data, port);
        break;
      case "clear_plots":
        clearLocalPlots();
        break;
      case "plot_list":
        const serverPlots = data.plots || [];
        const savedState = vscode.getState() || {};
        const savedPlots = savedState.plots || [];
        const savedMetadataMap = /* @__PURE__ */ new Map();
        savedPlots.forEach((sp) => {
          if (sp.id) {
            savedMetadataMap.set(sp.id, {
              note: sp.note || "",
              isFavorite: sp.isFavorite || false
            });
          }
        });
        const incomingPlots = serverPlots.map((serverPlot) => {
          const savedMetadata = savedMetaMap.get(serverPlot.id) || savedMetadataMap.get(serverPlot.id);
          return {
            ...serverPlot,
            data: plotUrls.get(serverPlot.id) || "",
            // Restore URL if we have it
            note: savedMetadata?.note || "",
            isFavorite: savedMetadata?.isFavorite || false
          };
        });
        plots = mergePlotLists(plots, incomingPlots, port);
        rehydratePlots();
        persistArchive();
        break;
    }
  }
  async function exportAsFormat(format, opts = {}) {
    if (currentIndex < 0) return;
    const plot = plots[currentIndex];
    const hasAnnotation = lastCanvasData.has(String(plot.id));
    log(`Preparing export for plot ${plot.id} as ${format} (Has annotation: ${hasAnnotation})`);
    if (!isSplitMode && plot.format === "svg" && format === "svg" && !hasAnnotation) {
      log("Direct SVG export...");
      try {
        const response = await fetch(plot.data);
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          vscode.postMessage({ command: "save_data", data: reader.result, format: "svg" });
        };
        reader.readAsDataURL(blob);
        return;
      } catch (e) {
        log("Direct SVG export failed: " + e);
      }
    }
    if (format === "svg") {
      log("Generating composite SVG...");
      let compositeData;
      if (isSplitMode) {
        compositeData = await generateSplitCompositeSVG(plots[leftIndex], plots[rightIndex]);
      } else if (hasAnnotation) {
        compositeData = await generateCompositeSVG(plot);
      }
      if (compositeData) {
        vscode.postMessage({ command: "save_data", data: compositeData, format: "svg" });
        return;
      }
    }
    const deliverRaster = (blob) => {
      if (!blob) {
        log("Failed to create plot blob");
        vscode.postMessage({ command: "info", text: "Export failed: Could not process image" });
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        if (format === "pdf") {
          deliverPdf(reader.result);
        } else {
          vscode.postMessage({ command: "save_data", data: reader.result, format });
        }
      };
      reader.readAsDataURL(blob);
    };
    if (isSplitMode) {
      getSplitCombinedBlob(plots[leftIndex], plots[rightIndex], deliverRaster, opts);
    } else {
      getCombinedPlotBlob(plot, deliverRaster, opts);
    }
  }
  function deliverPdf(pngDataUrl) {
    try {
      const jsPDFCtor = window.jspdf && window.jspdf.jsPDF || window.jsPDF;
      if (!jsPDFCtor) {
        vscode.postMessage({ command: "info", text: "PDF export unavailable: library not loaded" });
        return;
      }
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 800;
        const h = img.naturalHeight || 600;
        const doc = new jsPDFCtor({
          orientation: w >= h ? "landscape" : "portrait",
          unit: "px",
          format: [w, h]
        });
        doc.addImage(pngDataUrl, "PNG", 0, 0, w, h);
        const pdfDataUri = doc.output("datauristring");
        vscode.postMessage({ command: "save_data", data: pdfDataUri, format: "pdf" });
      };
      img.onerror = () => {
        vscode.postMessage({ command: "info", text: "PDF export failed: could not read image" });
      };
      img.src = pngDataUrl;
    } catch (e) {
      log("PDF export failed: " + e);
      vscode.postMessage({ command: "info", text: "PDF export failed" });
    }
  }
  async function generateCompositeSVG(plot) {
    try {
      const annotationData = lastCanvasData.get(String(plot.id));
      if (!annotationData) return null;
      const basePlotData = await new Promise((res) => {
        fetch(plot.data).then((r) => r.blob()).then((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result);
          reader.readAsDataURL(blob);
        }).catch(() => res(plot.data));
      });
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = plot.data;
      });
      const w = img.naturalWidth || 800;
      const h = img.naturalHeight || 600;
      const svg = `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <image href="${basePlotData}" width="${w}" height="${h}" />
    <image href="${annotationData}" width="${w}" height="${h}" />
</svg>`.trim();
      return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    } catch (e) {
      log("Composite SVG generation failed: " + e);
      return null;
    }
  }
  function rehydratePlots() {
    updatePlotList();
    if (state.sidebarHidden) {
      document.querySelector(".sidebar").classList.add("sidebar-hidden");
    }
    if (plots.length > 0) {
      if (currentIndex >= plots.length) currentIndex = plots.length - 1;
      if (currentIndex < 0) currentIndex = 0;
      showPlot(currentIndex, false);
    } else {
      clearLocalPlots();
    }
  }
  function updateConnectionStatus(connected) {
    const dot = document.getElementById("statusDot");
    const logosContainer = document.getElementById("statusLogos");
    if (connected) {
      dot.classList.add("connected");
      const connectedLangs = /* @__PURE__ */ new Set();
      for (const [port, socket] of activeSockets) {
        if (socket.readyState === WebSocket.OPEN) {
          const lang = portLanguages.get(port);
          if (lang) connectedLangs.add(lang);
        }
      }
      if (logosContainer) {
        logosContainer.innerHTML = "";
        const sortedLangs = Array.from(connectedLangs).sort();
        if (sortedLangs.length === 0) {
          const activeText = document.createElement("span");
          activeText.textContent = "Active";
          activeText.style.fontSize = "10px";
          logosContainer.appendChild(activeText);
        } else {
          sortedLangs.forEach((lang) => {
            const logoSvg = LOGOS[lang.toLowerCase()];
            if (logoSvg) {
              const div = document.createElement("div");
              div.innerHTML = logoSvg;
              div.title = lang.charAt(0).toUpperCase() + lang.slice(1) + " Active";
              logosContainer.appendChild(div.firstChild);
            }
          });
        }
      }
    } else {
      dot.classList.remove("connected");
      if (logosContainer) {
        logosContainer.innerHTML = '<span style="font-size: 10px; opacity: 0.6;">Offline</span>';
      }
    }
  }
  function addPlot(plotUrl, metadata = {}, port) {
    const pid = metadata.id ? String(metadata.id) : String(Date.now());
    const existingIdx = plots.findIndex((p) => String(p.id) === pid);
    if (existingIdx >= 0) {
      log(`Idempotent addPlot: Updating existing plot ${pid}`);
      updateCurrentPlot(pid, plotUrl, port);
      return;
    }
    const plot = {
      id: pid,
      data: plotUrl,
      format: metadata.format || "svg",
      timestamp: metadata.timestamp || (/* @__PURE__ */ new Date()).toLocaleTimeString(),
      note: metadata.note || "",
      isFavorite: metadata.isFavorite || false,
      // Source provenance captured by the R server (for the code-actions menu).
      code: metadata.code || "",
      srcFile: metadata.srcFile || "",
      srcLine1: metadata.srcLine1,
      srcLine2: metadata.srcLine2,
      coords: metadata.coords,
      // base-graphics transform for hover-to-inspect (may be undefined)
      port: Number(port)
    };
    plots.push(plot);
    currentIndex = plots.length - 1;
    updatePlotList();
    showPlot(currentIndex, true);
    persistArchive();
  }
  function updateCurrentPlot(plotId, plotUrl, port, coords) {
    const pid = String(plotId);
    const index = plots.findIndex((p) => String(p.id) === pid);
    if (index >= 0) {
      plots[index].data = plotUrl;
      if (port) plots[index].port = Number(port);
      if (coords !== void 0) plots[index].coords = coords;
      if (!isSplitMode && index === currentIndex) {
        const plotImage2 = document.getElementById("plotImage");
        const wrapper = document.getElementById("mainMediaWrapper");
        if (plotImage2) {
          plotImage2.classList.add("changing");
          const tempImg = new Image();
          tempImg.onload = () => {
            setTimeout(() => {
              plotImage2.src = plotUrl;
              plotImage2.classList.remove("changing");
              plotImage2.style.display = "block";
              if (wrapper) {
                wrapper.style.display = "inline-block";
                updatePlotDimensions("mainMediaWrapper");
              }
              document.getElementById("emptyState").style.display = "none";
              restoreAnnotation(pid, "annotationCanvas");
            }, 100);
          };
          tempImg.src = plotUrl;
        }
      }
      if (isSplitMode) {
        if (index === leftIndex) {
          const leftPlot = document.getElementById("leftPlot");
          const leftWrapper = document.getElementById("leftMediaWrapper");
          if (leftPlot) {
            leftPlot.classList.add("changing");
            const tempImg = new Image();
            tempImg.onload = () => {
              leftPlot.src = plotUrl;
              leftPlot.classList.remove("changing");
              if (leftWrapper) {
                leftWrapper.style.display = "inline-block";
                updatePlotDimensions("leftMediaWrapper");
              }
              document.getElementById("emptyState").style.display = "none";
              restoreAnnotation(pid, "leftAnnotationCanvas");
            };
            tempImg.src = plotUrl;
          }
        }
        if (index === rightIndex) {
          const rightPlot = document.getElementById("rightPlot");
          const rightWrapper = document.getElementById("rightMediaWrapper");
          if (rightPlot) {
            rightPlot.classList.add("changing");
            const tempImg = new Image();
            tempImg.onload = () => {
              rightPlot.src = plotUrl;
              rightPlot.classList.remove("changing");
              if (rightWrapper) {
                rightWrapper.style.display = "inline-block";
                updatePlotDimensions("rightMediaWrapper");
              }
              document.getElementById("emptyState").style.display = "none";
              restoreAnnotation(pid, "rightAnnotationCanvas");
            };
            tempImg.src = plotUrl;
          }
        }
      }
      const thumbItem = document.getElementById("thumb-" + index);
      if (thumbItem) {
        thumbItem.src = plotUrl;
      }
    }
  }
  function clearLocalPlots() {
    plots = [];
    currentIndex = -1;
    leftIndex = -1;
    rightIndex = -1;
    lastCanvasData.clear();
    plotUrls.forEach((url) => URL.revokeObjectURL(url));
    plotUrls.clear();
    if (isSplitMode) {
      isSplitMode = false;
      document.body.classList.remove("is-split-mode");
      const splitBtn = document.getElementById("splitBtn");
      if (splitBtn) splitBtn.classList.remove("split-active-btn");
    }
    const wrappers = ["mainMediaWrapper", "leftMediaWrapper", "rightMediaWrapper"];
    const canvases = ["annotationCanvas", "leftAnnotationCanvas", "rightAnnotationCanvas"];
    wrappers.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
    canvases.forEach((id) => {
      const c = document.getElementById(id);
      if (c) {
        const ctx = c.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
      }
    });
    const plotImage2 = document.getElementById("plotImage");
    if (plotImage2) plotImage2.style.display = "none";
    const emptyState = document.getElementById("emptyState");
    if (emptyState) emptyState.style.display = "block";
    const splitContainer = document.getElementById("splitViewContainer");
    if (splitContainer) splitContainer.style.display = "none";
    vscode.setState({
      ...vscode.getState(),
      currentIndex: -1,
      plots: [],
      isSplitMode: false,
      leftIndex: -1,
      rightIndex: -1,
      annotations: void 0
    });
    updatePlotList();
    updateControls();
    saveState();
  }
  function deletePlot(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= plots.length) return;
    const plot = plots[index];
    const pid = plot.id;
    log(`Optimistic delete: Plot ${pid} (index ${index})`);
    broadcastToBackends({ type: "delete_plot", plot_id: pid });
    plots.splice(index, 1);
    if (plotUrls.has(pid)) {
      URL.revokeObjectURL(plotUrls.get(pid));
      plotUrls.delete(pid);
    }
    lastCanvasData.delete(pid);
    if (currentIndex === index) {
      currentIndex = plots.length > 0 ? Math.max(0, index - 1) : -1;
    } else if (currentIndex > index) {
      currentIndex--;
    }
    if (leftIndex === index) leftIndex = -1;
    else if (leftIndex > index) leftIndex--;
    if (rightIndex === index) rightIndex = -1;
    else if (rightIndex > index) rightIndex--;
    saveState();
    persistMeta();
    persistArchive();
    updatePlotList();
    if (plots.length > 0) {
      showPlot(currentIndex, false);
    } else {
      clearLocalPlots();
    }
  }
  function createPlotItemHTML(plot, index) {
    const isActive = index === currentIndex ? "active" : "";
    let splitClass = "";
    if (isSplitMode) {
      if (index === leftIndex) splitClass = "selected-left";
      if (index === rightIndex) splitClass = "selected-right";
    }
    const favoriteClass = plot.isFavorite ? "active" : "";
    const noteClass = plot.note ? "has-note" : "";
    const favoriteTitle = plot.isFavorite ? "Remove from favorites" : "Add to favorites";
    const noteTitle = plot.note ? "Edit note" : "Add note";
    const annoClass = lastCanvasData.has(String(plot.id)) ? "has-annotation" : "";
    let html = '<div class="plot-item ' + isActive + " " + splitClass + " " + annoClass + '" id="plot-item-' + index + '" ';
    html += 'onclick="showPlot(' + index + ')" ';
    html += 'draggable="true" ';
    html += 'ondragstart="handleDragStart(event, ' + index + ')" ';
    html += 'ondragend="handleDragEnd(event)">';
    if (isSplitMode) {
      html += '<div class="sidebar-select left-btn ' + (index === leftIndex ? "selected" : "") + '" onclick="setSplitPosition(' + index + `, 'left', event)" title="View on Left">L</div>`;
      html += '<div class="sidebar-select right-btn ' + (index === rightIndex ? "selected" : "") + '" onclick="setSplitPosition(' + index + `, 'right', event)" style="left: 30px;" title="View on Right">R</div>`;
    }
    const src = plotUrls.get(plot.id) || "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";
    html += '<img class="lazy-thumb" data-id="' + plot.id + '" src="' + src + '" loading="lazy" alt="Plot ' + (index + 1) + '" id="thumb-' + index + '"/>';
    html += '<div class="annotation-badge" title="Annotated (included in exports)">\u270E</div>';
    html += '<div class="thumbnail-footer">';
    html += '<div class="plot-meta">';
    html += '<div class="plot-index" style="font-weight:600">Plot ' + (index + 1) + "</div>";
    html += '<div class="plot-time">' + plot.timestamp + "</div>";
    html += "</div>";
    html += '<div class="thumbnail-actions">';
    html += '<div class="favorite-btn ' + favoriteClass + '" onclick="toggleFavorite(' + index + ', event)" title="' + favoriteTitle + '">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" /></svg>';
    html += "</div>";
    html += '<div class="note-btn ' + noteClass + '" onclick="showNoteDialog(' + index + ', event)" title="' + noteTitle + '">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-notes"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M5 3m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z" /><path d="M9 7l6 0" /><path d="M9 11l6 0" /><path d="M9 15l4 0" /></svg>';
    html += "</div>";
    html += '<div class="delete-btn" onclick="deletePlot(' + index + ', event)" title="Delete">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-xbox-x"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 2c5.523 0 10 4.477 10 10s-4.477 10 -10 10s-10 -4.477 -10 -10s4.477 -10 10 -10m3.6 5.2a1 1 0 0 0 -1.4 .2l-2.2 2.933l-2.2 -2.933a1 1 0 1 0 -1.6 1.2l2.55 3.4l-2.55 3.4a1 1 0 1 0 1.6 1.2l2.2 -2.933l2.2 2.933a1 1 0 0 0 1.6 -1.2l-2.55 -3.4l2.55 -3.4a1 1 0 0 0 -.2 -1.4" /></svg>';
    html += "</div>";
    html += "</div>";
    html += "</div>";
    html += "</div>";
    return html;
  }
  function updatePlotList() {
    const listEl = document.getElementById("plotList");
    if (!listEl) return;
    listEl.classList.toggle("is-split-mode", isSplitMode);
    if (thumbObserver) thumbObserver.disconnect();
    const badge = document.getElementById("countBadge");
    if (badge) badge.textContent = String(plots.length);
    if (plots.length === 0) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;opacity:0.5; font-style: italic;">No history</div>';
      return;
    }
    const displayPlots = showOnlyFavorites ? plots.filter((p) => p.isFavorite) : plots;
    if (displayPlots.length === 0 && showOnlyFavorites) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;opacity:0.5; font-style: italic;">No favorites</div>';
      return;
    }
    listEl.innerHTML = displayPlots.map((plot) => {
      const actualIndex = plots.indexOf(plot);
      return createPlotItemHTML(plot, actualIndex);
    }).join("");
    initThumbObserver();
  }
  function showPlot(index, shouldScroll = true) {
    if (index < 0 || index >= plots.length) return;
    if (isSplitMode) {
      if (activePane === "left") leftIndex = index;
      else rightIndex = index;
      currentIndex = index;
      const paneLabel = document.getElementById(activePane + "PaneLabel");
      if (paneLabel) paneLabel.textContent = "Plot " + (index + 1);
    } else {
      currentIndex = index;
    }
    const plot = plots[index];
    const pid = plot.id;
    saveState();
    const plotUrl = plotUrls.get(pid);
    if (plotUrl) {
      if (isSplitMode) {
        const paneImg = document.getElementById(activePane + "Plot");
        const wrapper = document.getElementById(activePane + "MediaWrapper");
        if (paneImg) {
          paneImg.classList.add("changing");
          const tempImg = new Image();
          tempImg.onload = () => {
            paneImg.src = plotUrl;
            paneImg.classList.remove("changing");
            if (wrapper) {
              wrapper.style.display = "inline-block";
              updatePlotDimensions(activePane + "MediaWrapper");
            }
            document.getElementById("emptyState").style.display = "none";
            restoreAnnotation(pid, activePane + "AnnotationCanvas");
          };
          tempImg.src = plotUrl;
        }
      } else {
        const plotImage2 = document.getElementById("plotImage");
        const wrapper = document.getElementById("mainMediaWrapper");
        if (plotImage2) {
          plotImage2.classList.add("changing");
          const tempImg = new Image();
          tempImg.onload = () => {
            plotImage2.src = plotUrl;
            plotImage2.classList.remove("changing");
            plotImage2.style.display = "block";
            if (wrapper) {
              wrapper.style.display = "inline-block";
              const z = plotZoom.get(String(pid)) || (vscode.getState() || {}).zoomLevel || "fit";
              wrapper.classList.remove("zoom-fit", "zoom-50", "zoom-75", "zoom-100", "zoom-200");
              wrapper.classList.add("zoom-" + z);
              updatePlotDimensions("mainMediaWrapper");
            }
            document.getElementById("emptyState").style.display = "none";
            restoreAnnotation(pid, "annotationCanvas");
          };
          tempImg.src = plotUrl;
        }
      }
    } else {
      broadcastToBackends({ type: "request_binary", plot_id: pid });
    }
    updateControls();
    updatePlotList();
    if (!isSplitMode) {
      document.querySelectorAll(".plot-item.active").forEach((el) => el.classList.remove("active"));
      const activeItem = document.getElementById("plot-item-" + index);
      if (activeItem) {
        activeItem.classList.add("active");
        if (shouldScroll) {
          activeItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
    }
  }
  function toggleSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const isHidden = sidebar.classList.toggle("sidebar-hidden");
    const currentState = vscode.getState() || {};
    vscode.setState({ ...currentState, sidebarHidden: isHidden });
    sendResizeEvent();
  }
  function openInNewWindow() {
    vscode.postMessage({ command: "open_new_window" });
  }
  function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    darkModeUserSet = true;
    document.body.classList.toggle("dark-mode", isDarkMode);
    updateDarkModeUI();
    const currentState = vscode.getState() || {};
    vscode.setState({ ...currentState, darkMode: isDarkMode });
  }
  function updateDarkModeUI() {
    const darkModeBtn = document.getElementById("darkModeBtn");
    if (!darkModeBtn) return;
    if (isDarkMode) {
      darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 3.34a10 10 0 1 1 -4.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 4.995 -8.336z" /></svg>';
    } else {
      darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /></svg>';
    }
  }
  function toggleZoom() {
    const side = isSplitMode ? activePane : "main";
    const wrapperId = isSplitMode ? activePane + "MediaWrapper" : "mainMediaWrapper";
    const target = document.getElementById(wrapperId);
    if (!target) return;
    const zoomBtn = document.getElementById("zoomBtn");
    const zoomLevels = ["fit", "50", "75", "100", "200"];
    let currentZoom = getZoomFromClass(target);
    let idx = zoomLevels.indexOf(currentZoom);
    idx = (idx + 1) % zoomLevels.length;
    const newZoom = zoomLevels[idx];
    target.classList.remove("zoom-fit", "zoom-50", "zoom-75", "zoom-100", "zoom-200");
    target.classList.add("zoom-" + newZoom);
    updatePlotDimensions(wrapperId);
    showZoomNotification(newZoom);
    if (newZoom === "fit") {
      zoomBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-zoom-pan"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M17 17l-2.5 -2.5" /><path d="M10 4l2 -2l2 2" /><path d="M20 10l2 2l-2 2" /><path d="M4 10l-2 2l2 2" /><path d="M10 20l2 2l2 -2" /></svg>';
    } else {
      zoomBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-zoom-pan"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 8a4 4 0 0 1 3.447 6.031l2.26 2.262a1 1 0 0 1 -1.414 1.414l-2.262 -2.26a4 4 0 0 1 -6.031 -3.447l.005 -.2a4 4 0 0 1 3.995 -3.8" /><path d="M11.293 1.293a1 1 0 0 1 1.414 0l2 2a1 1 0 1 1 -1.414 1.414l-1.293 -1.292l-1.293 1.292a1 1 0 0 1 -1.32 .083l-.094 -.083a1 1 0 0 1 0 -1.414z" /><path d="M19.293 9.293a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 -1.414l1.292 -1.293l-1.292 -1.293a1 1 0 0 1 -.083 -1.32z" /><path d="M3.293 9.293a1 1 0 1 1 1.414 1.414l-1.292 1.293l1.292 1.293a1 1 0 0 1 .083 1.32l-.083 .094a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414z" /><path d="M9.293 19.293a1 1 0 0 1 1.414 0l1.293 1.292l1.294 -1.292a1 1 0 0 1 1.32 -.083l.094 .083a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414" /></svg>';
    }
    showZoomNotification(newZoom);
    if (!isSplitMode) {
      vscode.setState({ ...vscode.getState(), zoomLevel: newZoom });
      if (currentIndex >= 0 && plots[currentIndex]) {
        plotZoom.set(String(plots[currentIndex].id), newZoom);
        saveState();
      }
    }
    if (isSplitMode) {
      if (leftIndex >= 0) restoreAnnotation(plots[leftIndex].id, "leftAnnotationCanvas");
      if (rightIndex >= 0) restoreAnnotation(plots[rightIndex].id, "rightAnnotationCanvas");
    } else if (currentIndex >= 0 && plots[currentIndex]) {
      restoreAnnotation(plots[currentIndex].id, "annotationCanvas");
    }
    if (isAnnotating) {
      setupActiveCanvas();
    }
    setTimeout(() => sendResizeEvent(), 50);
  }
  function toggleAspectRatio() {
    const side = isSplitMode ? activePane : "main";
    const wrapperId = isSplitMode ? activePane + "MediaWrapper" : "mainMediaWrapper";
    const target = document.getElementById(wrapperId);
    if (!target) return;
    const aspectBtn = document.getElementById("aspectBtn");
    const aspectRatios = ["auto", "square", "landscape", "portrait", "fill"];
    let currentAspect = getScaleFromClass(target);
    let idx = aspectRatios.indexOf(currentAspect);
    idx = (idx + 1) % aspectRatios.length;
    const newAspect = aspectRatios[idx];
    target.classList.remove("aspect-auto", "aspect-square", "aspect-landscape", "aspect-portrait", "aspect-fill");
    target.classList.add("aspect-" + newAspect);
    updatePlotDimensions(wrapperId);
    const isFixedAspect = newAspect !== "auto" && newAspect !== "fill";
    target.classList.toggle("has-aspect", isFixedAspect);
    if (isSplitMode) {
      if (leftIndex >= 0) restoreAnnotation(plots[leftIndex].id, "leftAnnotationCanvas");
      if (rightIndex >= 0) restoreAnnotation(plots[rightIndex].id, "rightAnnotationCanvas");
    } else if (currentIndex >= 0 && plots[currentIndex]) {
      restoreAnnotation(plots[currentIndex].id, "annotationCanvas");
    }
    if (isAnnotating) {
      setupActiveCanvas();
    }
    if (newAspect === "auto") {
      aspectBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M17 3l4 4l-14 14l-4 -4z" /><path d="M16 7l-1.5 -1.5" /><path d="M13 10l-1.5 -1.5" /><path d="M10 13l-1.5 -1.5" /><path d="M7 16l-1.5 -1.5" /></svg>';
    } else {
      aspectBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2-off"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12.03 7.97l4.97 -4.97l4 4l-5 5m-2 2l-7 7l-4 -4l7 -7" /><path d="M16 7l-1.5 -1.5" /><path d="M13 10l-1.5 -1.5" /><path d="M10 13l-1.5 -1.5" /><path d="M7 16l-1.5 -1.5" /><path d="M3 3l18 18" /></svg>';
    }
    showAspectNotification(newAspect);
    if (!isSplitMode) {
      vscode.setState({ ...vscode.getState(), aspectRatio: newAspect });
    }
    setTimeout(() => sendResizeEvent(), 50);
  }
  function showAspectNotification(aspectRatio2) {
    const notification = document.getElementById("aspectNotification");
    if (!notification) return;
    notification.textContent = aspectRatio2.charAt(0).toUpperCase() + aspectRatio2.slice(1);
    notification.classList.add("show");
    setTimeout(() => notification.classList.remove("show"), 1500);
  }
  function updateControls() {
    const hasPlots = plots.length > 0;
    const canSplit = plots.length >= 2;
    document.getElementById("prevBtn").disabled = !hasPlots || currentIndex === 0 || isSplitMode;
    document.getElementById("nextBtn").disabled = !hasPlots || currentIndex === plots.length - 1 || isSplitMode;
    document.getElementById("exportBtn").disabled = !hasPlots;
    document.getElementById("copyBtn").disabled = !hasPlots;
    const codeBtn = document.getElementById("codeBtn");
    if (codeBtn) codeBtn.disabled = !hasPlots || isSplitMode;
    document.getElementById("newWindowBtn").disabled = !hasPlots;
    document.getElementById("clearBtn").disabled = !hasPlots;
    document.getElementById("zoomBtn").disabled = !hasPlots;
    document.getElementById("aspectBtn").disabled = !hasPlots;
    document.getElementById("annotateBtn").disabled = !hasPlots;
    document.getElementById("darkModeBtn").disabled = !hasPlots;
    document.getElementById("favoriteFilterBtn").disabled = !hasPlots;
    const splitBtn = document.getElementById("splitBtn");
    if (splitBtn) {
      splitBtn.disabled = !canSplit;
      splitBtn.classList.toggle("split-active-btn", isSplitMode);
    }
    const diffBtn = document.getElementById("diffBtn");
    if (diffBtn) diffBtn.disabled = !canSplit;
    document.getElementById("plotInfo").textContent = isSplitMode ? "SPLIT" : hasPlots ? `${currentIndex + 1} / ${plots.length}` : "";
  }
  function previousPlot() {
    if (currentIndex > 0) showPlot(currentIndex - 1);
  }
  function nextPlot() {
    if (currentIndex < plots.length - 1) showPlot(currentIndex + 1);
  }
  function normPath(p) {
    return String(p || "").replace(/\\/g, "/").toLowerCase();
  }
  function basePath(p) {
    const n = normPath(p);
    return n.substring(n.lastIndexOf("/") + 1);
  }
  function highlightPlotsForSource(file, line) {
    document.querySelectorAll(".plot-item.source-linked").forEach((el) => el.classList.remove("source-linked"));
    if (!file || typeof line !== "number") return;
    const targetFull = normPath(file);
    const targetBase = basePath(file);
    let firstIdx = -1;
    plots.forEach((plot, idx) => {
      if (!plot.srcFile || typeof plot.srcLine1 !== "number") return;
      const sameFile = normPath(plot.srcFile) === targetFull || basePath(plot.srcFile) === targetBase;
      if (!sameFile) return;
      const l1 = plot.srcLine1;
      const l2 = typeof plot.srcLine2 === "number" && plot.srcLine2 >= l1 ? plot.srcLine2 : l1;
      if (line < l1 || line > l2) return;
      const el = document.getElementById("plot-item-" + idx);
      if (el) el.classList.add("source-linked");
      if (firstIdx < 0) firstIdx = idx;
    });
    if (firstIdx >= 0) {
      const el = document.getElementById("plot-item-" + firstIdx);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  function clearAllPlots() {
    broadcastToBackends({ type: "clear_all" });
    clearLocalPlots();
    vscode.postMessage({ command: "persist_archive", plots: [] });
    vscode.postMessage({ command: "persist_meta", meta: [] });
    savedMetaMap = /* @__PURE__ */ new Map();
  }
  function exportPlot() {
    if (currentIndex < 0) return;
    vscode.postMessage({ command: "request_export" });
  }
  function copyToClipboard() {
    if (currentIndex < 0 || plots.length === 0) {
      log("Copy failed: No plot selected");
      return;
    }
    const processBlob = (blob) => {
      if (!blob) {
        log("Failed to create blob for clipboard");
        return;
      }
      const data = [new ClipboardItem({ [blob.type]: blob })];
      navigator.clipboard.write(data).then(() => {
        log("Clipboard write success");
        vscode.postMessage({ command: "info", text: "Copied to clipboard" + (isSplitMode ? " (Split View)" : "") });
      }).catch((err) => {
        log("Clipboard API failed: " + err);
        vscode.postMessage({ command: "info", text: "Copy failed: Clipboard access required" });
      });
    };
    if (isSplitMode) {
      getSplitCombinedBlob(plots[leftIndex], plots[rightIndex], processBlob);
    } else {
      getCombinedPlotBlob(plots[currentIndex], processBlob);
    }
  }
  async function copySvgToClipboard() {
    if (currentIndex < 0 || plots.length === 0) return;
    const plot = plots[currentIndex];
    if (!plot || plot.format !== "svg" || !plot.data) {
      vscode.postMessage({ command: "info", text: "Copy as SVG: this plot is not a vector image" });
      return;
    }
    try {
      const res = await fetch(plot.data);
      const svgText = await res.text();
      await navigator.clipboard.writeText(svgText);
      log("SVG markup copied to clipboard");
      vscode.postMessage({ command: "info", text: "SVG copied to clipboard" });
    } catch (err) {
      log("Copy as SVG failed: " + err);
      vscode.postMessage({ command: "info", text: "Copy as SVG failed: clipboard access required" });
    }
  }
  var diffA = -1;
  var diffB = -1;
  function openDiffView() {
    let a = -1, b = -1;
    if (isSplitMode && leftIndex >= 0 && rightIndex >= 0) {
      a = leftIndex;
      b = rightIndex;
    } else if (currentIndex >= 1) {
      a = currentIndex - 1;
      b = currentIndex;
    }
    if (a < 0 || b < 0 || !plots[a] || !plots[b]) {
      vscode.postMessage({ command: "info", text: "Diff needs two plots (pick two in Split View, or view a plot after the first)" });
      return;
    }
    diffA = a;
    diffB = b;
    document.getElementById("diffModal").classList.add("show");
    computeDiff();
  }
  function closeDiffModal() {
    document.getElementById("diffModal").classList.remove("show");
    diffA = -1;
    diffB = -1;
  }
  async function computeDiff() {
    if (diffA < 0 || diffB < 0) return;
    const stats = document.getElementById("diffStats");
    const canvas = document.getElementById("diffCanvas");
    if (!canvas) return;
    try {
      const load = (url) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = url;
      });
      const [imgA, imgB] = await Promise.all([load(plots[diffA].data), load(plots[diffB].data)]);
      const w = imgA.naturalWidth || 800;
      const h = imgA.naturalHeight || 600;
      const mk = (img) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d");
        x.fillStyle = "white";
        x.fillRect(0, 0, w, h);
        x.drawImage(img, 0, 0, w, h);
        return x.getImageData(0, 0, w, h);
      };
      const da = mk(imgA), db = mk(imgB);
      const thrEl = document.getElementById("diffThreshold");
      const threshold = thrEl ? Number(thrEl.value) || 0 : 16;
      const r = diffPixels(da.data, db.data, { threshold });
      canvas.width = w;
      canvas.height = h;
      const outCtx = canvas.getContext("2d");
      const outImage = outCtx.createImageData(w, h);
      outImage.data.set(r.out);
      outCtx.putImageData(outImage, 0, 0);
      const pct = r.total ? 100 * r.changed / r.total : 0;
      if (stats) {
        stats.textContent = `Plot ${diffA + 1} vs Plot ${diffB + 1}: ${r.changed.toLocaleString()} of ${r.total.toLocaleString()} pixels changed (${pct.toFixed(2)}%)`;
      }
    } catch (e) {
      log("Diff failed: " + e);
      if (stats) stats.textContent = "Diff failed: could not rasterise one of the plots";
    }
  }
  var inspectTipEl = null;
  var inspectMode = "hover";
  var measurePts = [];
  var cropStart = null;
  function ensureInspectTip() {
    if (inspectTipEl) return inspectTipEl;
    inspectTipEl = document.createElement("div");
    inspectTipEl.className = "inspect-tip";
    inspectTipEl.style.display = "none";
    document.body.appendChild(inspectTipEl);
    return inspectTipEl;
  }
  function inspectActivePlot() {
    const plot = currentIndex >= 0 ? plots[currentIndex] : null;
    if (!hoverInspectEnabled || isAnnotating || isSplitMode || !plot || !plot.coords) return null;
    return plot;
  }
  function inspectOverlayCtx() {
    const img = document.getElementById("plotImage");
    const overlay = document.getElementById("inspectOverlay");
    if (!img || !overlay) return null;
    const w = img.clientWidth, h = img.clientHeight;
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    return { ctx: overlay.getContext("2d"), w, h, img };
  }
  function clearInspectOverlay() {
    const o = inspectOverlayCtx();
    if (o) o.ctx.clearRect(0, 0, o.w, o.h);
  }
  function inspectLabel(ctx, text, x, y) {
    ctx.font = "11px monospace";
    const pad = 3, tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(x, y - 12, tw + pad * 2, 15);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + pad, y);
  }
  function pixelInImage(e, img) {
    const rect = img.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top, w: rect.width, h: rect.height };
  }
  function drawHoverInspect(plot, px, py, w, h) {
    const o = inspectOverlayCtx();
    if (!o) return;
    o.ctx.clearRect(0, 0, o.w, o.h);
    const d = dataAtPixel(px, py, w, h, plot.coords);
    const tip = ensureInspectTip();
    if (!d) {
      tip.style.display = "none";
      return;
    }
    const sx = o.w / w, sy = o.h / h;
    const ox = px * sx, oy = py * sy;
    const panel = panelPixelRect(o.w, o.h, plot.coords);
    const bottom = panel ? panel.bottom : o.h;
    const left = panel ? panel.left : 0;
    o.ctx.strokeStyle = "rgba(255,64,129,0.9)";
    o.ctx.lineWidth = 1;
    o.ctx.setLineDash([4, 3]);
    o.ctx.beginPath();
    o.ctx.moveTo(ox, oy);
    o.ctx.lineTo(ox, bottom);
    o.ctx.moveTo(ox, oy);
    o.ctx.lineTo(left, oy);
    o.ctx.stroke();
    o.ctx.setLineDash([]);
    inspectLabel(o.ctx, formatInspectValue(d.x), ox + 2, bottom - 3);
    inspectLabel(o.ctx, formatInspectValue(d.y), left + 3, oy - 2);
    tip.textContent = `x: ${formatInspectValue(d.x)}    y: ${formatInspectValue(d.y)}`;
    tip.style.display = "block";
    tip.style.left = px + document.getElementById("plotImage").getBoundingClientRect().left + 14 + "px";
    tip.style.top = py + document.getElementById("plotImage").getBoundingClientRect().top + 14 + "px";
  }
  function drawMeasure(plot, curPx, curPy, w, h) {
    const o = inspectOverlayCtx();
    if (!o) return;
    o.ctx.clearRect(0, 0, o.w, o.h);
    const sx = o.w / w, sy = o.h / h;
    const tip = ensureInspectTip();
    const pts = measurePts.slice();
    const live = pts.length === 1 ? { px: curPx, py: curPy } : null;
    const a = pts[0], b = pts[1] || live;
    o.ctx.fillStyle = o.ctx.strokeStyle = "rgba(255,64,129,0.95)";
    for (const p of pts) {
      o.ctx.beginPath();
      o.ctx.arc(p.px * sx, p.py * sy, 3, 0, 7);
      o.ctx.fill();
    }
    if (a && b) {
      o.ctx.lineWidth = 1.5;
      o.ctx.beginPath();
      o.ctx.moveTo(a.px * sx, a.py * sy);
      o.ctx.lineTo(b.px * sx, b.py * sy);
      o.ctx.stroke();
      const da = dataAtPixel(a.px, a.py, w, h, plot.coords);
      const db = dataAtPixel(b.px, b.py, w, h, plot.coords);
      if (da && db) {
        const dx = db.x - da.x, dy = db.y - da.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const txt = `\u0394x: ${formatInspectValue(dx)}   \u0394y: ${formatInspectValue(dy)}   |d|: ${formatInspectValue(dist)}`;
        inspectLabel(o.ctx, txt, Math.min(a.px, b.px) * sx, Math.min(a.py, b.py) * sy - 4);
        tip.style.display = "none";
      }
    }
  }
  function drawCrop(curPx, curPy, w, h) {
    const o = inspectOverlayCtx();
    if (!o || !cropStart) return;
    o.ctx.clearRect(0, 0, o.w, o.h);
    const sx = o.w / w, sy = o.h / h;
    const x = cropStart.px * sx, y = cropStart.py * sy;
    const cw = (curPx - cropStart.px) * sx, ch = (curPy - cropStart.py) * sy;
    o.ctx.strokeStyle = "rgba(30,144,255,0.95)";
    o.ctx.fillStyle = "rgba(30,144,255,0.12)";
    o.ctx.lineWidth = 1;
    o.ctx.fillRect(x, y, cw, ch);
    o.ctx.strokeRect(x, y, cw, ch);
  }
  function zoomNumber(v) {
    return String(Number(v.toPrecision(6)));
  }
  function commitCrop(plot, endPx, endPy, w, h) {
    const p0 = dataAtPixel(cropStart.px, cropStart.py, w, h, plot.coords);
    const p1 = dataAtPixel(endPx, endPy, w, h, plot.coords);
    cropStart = null;
    clearInspectOverlay();
    if (!p0 || !p1) return;
    if (Math.abs(p1.x - p0.x) < 1e-12 || Math.abs(p1.y - p0.y) < 1e-12) return;
    const xlim = [Math.min(p0.x, p1.x), Math.max(p0.x, p1.x)];
    const ylim = [Math.min(p0.y, p1.y), Math.max(p0.y, p1.y)];
    const cmd = `xlim <- c(${zoomNumber(xlim[0])}, ${zoomNumber(xlim[1])}); ylim <- c(${zoomNumber(ylim[0])}, ${zoomNumber(ylim[1])})  # R Plot Pro zoom region`;
    vscode.postMessage({ command: "reveal_code", code: cmd });
    vscode.postMessage({ command: "info", text: "Zoom limits sent to the R console" });
  }
  function initHoverInspect() {
    const img = document.getElementById("plotImage");
    if (!img || img.hasInspectListener) return;
    img.hasInspectListener = true;
    ensureInspectTip();
    img.addEventListener("mousemove", (e) => {
      const plot = inspectActivePlot();
      if (!plot) {
        ensureInspectTip().style.display = "none";
        img.style.cursor = "";
        clearInspectOverlay();
        return;
      }
      img.style.cursor = "crosshair";
      const { px, py, w, h } = pixelInImage(e, img);
      if (inspectMode === "measure") drawMeasure(plot, px, py, w, h);
      else if (inspectMode === "crop") {
        if (cropStart) drawCrop(px, py, w, h);
      } else drawHoverInspect(plot, px, py, w, h);
    });
    img.addEventListener("mouseleave", () => {
      ensureInspectTip().style.display = "none";
      img.style.cursor = "";
      if (inspectMode === "hover") clearInspectOverlay();
    });
    img.addEventListener("click", (e) => {
      const plot = inspectActivePlot();
      if (!plot || inspectMode !== "measure") return;
      const { px, py, w, h } = pixelInImage(e, img);
      const d = dataAtPixel(px, py, w, h, plot.coords);
      if (!d) return;
      if (measurePts.length >= 2) measurePts = [];
      measurePts.push({ px, py, x: d.x, y: d.y });
      drawMeasure(plot, px, py, w, h);
    });
    img.addEventListener("mousedown", (e) => {
      const plot = inspectActivePlot();
      if (!plot || inspectMode !== "crop") return;
      const { px, py } = pixelInImage(e, img);
      cropStart = { px, py };
      e.preventDefault();
    });
    window.addEventListener("mouseup", (e) => {
      if (inspectMode !== "crop" || !cropStart) return;
      const plot = inspectActivePlot();
      const { px, py, w, h } = pixelInImage(e, img);
      if (plot) commitCrop(plot, px, py, w, h);
      else {
        cropStart = null;
        clearInspectOverlay();
      }
    });
  }
  function setInspectMode(mode) {
    inspectMode = mode;
    measurePts = [];
    cropStart = null;
    clearInspectOverlay();
    ensureInspectTip().style.display = "none";
  }
  async function exportGridMontage() {
    const favs = plots.filter((p) => p.isFavorite);
    const set = (favs.length ? favs : plots).slice(0, 16);
    if (set.length < 2) {
      vscode.postMessage({ command: "info", text: "Grid export needs at least two plots (favourite the ones you want)" });
      return;
    }
    try {
      const load = (url) => new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      const imgs = await Promise.all(set.map((p) => load(p.data)));
      const cellW = 500, cellH = 360, gap = 14;
      const layout = computeGridLayout(imgs.length, cellW, cellH, gap);
      const canvas = document.createElement("canvas");
      canvas.width = layout.canvasW;
      canvas.height = layout.canvasH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      imgs.forEach((im, i) => {
        const cell = layout.cells[i];
        const nw = im.naturalWidth || 800, nh = im.naturalHeight || 600;
        const r = Math.min(cell.w / nw, cell.h / nh);
        const dw = nw * r, dh = nh * r;
        ctx.drawImage(im, cell.x + (cell.w - dw) / 2, cell.y + (cell.h - dh) / 2, dw, dh);
      });
      canvas.toBlob((blob) => {
        if (!blob) {
          vscode.postMessage({ command: "info", text: "Grid export failed" });
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => vscode.postMessage({ command: "save_data", data: reader.result, format: "png" });
        reader.readAsDataURL(blob);
      }, "image/png", 0.95);
    } catch (e) {
      log("Grid export failed: " + e);
      vscode.postMessage({ command: "info", text: "Grid export failed" });
    }
  }
  function refreshLayout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w < 500 || h > w * 0.85) {
      document.body.classList.add("layout-vertical");
    } else {
      document.body.classList.remove("layout-vertical");
    }
    if (isSplitMode) {
      updatePlotDimensions("leftMediaWrapper");
      updatePlotDimensions("rightMediaWrapper");
    } else {
      updatePlotDimensions("mainMediaWrapper");
    }
    setupPanLogic();
  }
  var isPanning = false;
  var panStartX = 0;
  var panStartY = 0;
  var panScrollLeft = 0;
  var panScrollTop = 0;
  var activePanContainer = null;
  function setupPanLogic() {
    const containers = isSplitMode ? [document.getElementById("leftPane"), document.getElementById("rightPane")] : [document.getElementById("plotContainer")];
    containers.forEach((container) => {
      if (!container || container.hasPanListener) return;
      container.addEventListener("mousedown", (e) => {
        if (e.target.closest(".icon-btn") || e.target.closest(".split-divider") || isAnnotating) return;
        isPanning = true;
        activePanContainer = container;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panScrollLeft = container.scrollLeft;
        panScrollTop = container.scrollTop;
        container.classList.add("dragging");
        document.body.style.cursor = "grabbing";
        e.preventDefault();
      });
      container.hasPanListener = true;
    });
  }
  window.addEventListener("mousemove", (e) => {
    if (!isPanning || !activePanContainer) return;
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    const dx = x - panStartX;
    const dy = y - panStartY;
    activePanContainer.scrollLeft = panScrollLeft - dx;
    activePanContainer.scrollTop = panScrollTop - dy;
  });
  window.addEventListener("mouseup", () => {
    if (isPanning) {
      isPanning = false;
      if (activePanContainer) activePanContainer.classList.remove("dragging");
      activePanContainer = null;
      document.body.style.cursor = "";
    }
  });
  function sendResizeEvent() {
    let container = document.getElementById("plotContainer");
    if (isSplitMode) {
      container = document.getElementById(activePane + "Pane");
    }
    if (container) {
      let width = Math.floor(container.clientWidth);
      let height = Math.floor(container.clientHeight);
      const wrapperId = isSplitMode ? activePane + "MediaWrapper" : "mainMediaWrapper";
      const wrapper = document.getElementById(wrapperId);
      let aspectRatio2 = "auto";
      if (wrapper) {
        const ratios = ["square", "landscape", "portrait", "fill"];
        ratios.forEach((r) => {
          if (wrapper.classList.contains("aspect-" + r)) aspectRatio2 = r;
        });
      }
      if (aspectRatio2 === "square") {
        const size = Math.min(width, height);
        width = height = size;
      } else if (aspectRatio2 === "landscape") {
        const ratio = 4 / 3;
        if (width / height > ratio) {
          width = Math.floor(height * ratio);
        } else {
          height = Math.floor(width / ratio);
        }
      } else if (aspectRatio2 === "portrait") {
        const ratio = 3 / 4;
        if (width / height > ratio) {
          width = Math.floor(height * ratio);
        } else {
          height = Math.floor(width / ratio);
        }
      }
      let pid;
      if (isSplitMode) {
        const idx = activePane === "left" ? leftIndex : rightIndex;
        pid = idx >= 0 && idx < plots.length ? plots[idx].id : null;
      } else {
        pid = currentIndex >= 0 && currentIndex < plots.length ? plots[currentIndex].id : null;
      }
      if (width > 50 && height > 50) {
        const targetPlot = isSplitMode ? plots[activePane === "left" ? leftIndex : rightIndex] : plots[currentIndex];
        const targetPort = targetPlot ? targetPlot.port : null;
        broadcastToBackends({ type: "resize", width, height, plot_id: pid }, targetPort);
      }
    }
  }
  window.addEventListener("resize", debounce(() => {
    refreshLayout();
    sendResizeEvent();
  }, 200));
  function handleDragStart(event, index) {
    event.stopPropagation();
    const plot = plots[index];
    event.target.classList.add("dragging");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("DownloadURL", "image/png:plot_" + (index + 1) + ".png:" + plot.data);
  }
  function handleDragEnd(event) {
    event.target.classList.remove("dragging");
  }
  var codeMenuEl = null;
  var codeMenuIndex = -1;
  function buildCodeMenu() {
    if (codeMenuEl) return codeMenuEl;
    codeMenuEl = document.createElement("div");
    codeMenuEl.className = "code-menu";
    codeMenuEl.style.display = "none";
    codeMenuEl.innerHTML = '<div class="code-menu-item" data-act="copy">Copy Code</div><div class="code-menu-item" data-act="reveal">Reveal Code in Console</div><div class="code-menu-item" data-act="run">Run Code Again</div><div class="code-menu-item" data-act="open">Open Source File</div>';
    codeMenuEl.addEventListener("click", (e) => {
      const item = e.target.closest(".code-menu-item");
      if (!item || item.classList.contains("disabled")) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      const act = item.getAttribute("data-act");
      const idx = codeMenuIndex;
      hideCodeMenu();
      runCodeAction(act, idx);
    });
    document.body.appendChild(codeMenuEl);
    return codeMenuEl;
  }
  function hideCodeMenu() {
    if (codeMenuEl) codeMenuEl.style.display = "none";
    codeMenuIndex = -1;
  }
  function toggleCodeMenu(index, event) {
    if (event) event.stopPropagation();
    const menu = buildCodeMenu();
    if (menu.style.display === "block" && codeMenuIndex === index) {
      hideCodeMenu();
      return;
    }
    codeMenuIndex = index;
    const plot = plots[index] || {};
    const hasCode = !!(plot.code && String(plot.code).trim());
    const hasFile = !!(plot.srcFile && String(plot.srcFile).trim());
    menu.querySelector('[data-act="copy"]').classList.toggle("disabled", !hasCode);
    menu.querySelector('[data-act="reveal"]').classList.toggle("disabled", !hasCode);
    menu.querySelector('[data-act="run"]').classList.toggle("disabled", !hasCode);
    menu.querySelector('[data-act="open"]').classList.toggle("disabled", !hasFile);
    menu.style.display = "block";
    const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : { left: 8, right: 8, top: 8, bottom: 8 };
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 130;
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  var copyMenuEl = null;
  function buildCopyMenu() {
    if (copyMenuEl) return copyMenuEl;
    copyMenuEl = document.createElement("div");
    copyMenuEl.className = "code-menu";
    copyMenuEl.style.display = "none";
    copyMenuEl.innerHTML = '<div class="code-menu-item" data-act="png">Copy as PNG</div><div class="code-menu-item" data-act="svg">Copy as SVG (vector)</div>';
    copyMenuEl.addEventListener("click", (e) => {
      const item = e.target.closest(".code-menu-item");
      if (!item || item.classList.contains("disabled")) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      const act = item.getAttribute("data-act");
      hideCopyMenu();
      if (act === "svg") copySvgToClipboard();
      else copyToClipboard();
    });
    document.body.appendChild(copyMenuEl);
    return copyMenuEl;
  }
  function hideCopyMenu() {
    if (copyMenuEl) copyMenuEl.style.display = "none";
  }
  function toggleCopyMenu(event) {
    if (event) event.stopPropagation();
    if (currentIndex < 0 || plots.length === 0) return;
    const menu = buildCopyMenu();
    if (menu.style.display === "block") {
      hideCopyMenu();
      return;
    }
    const cur = plots[currentIndex];
    const canSvg = !isSplitMode && !!cur && cur.format === "svg";
    menu.querySelector('[data-act="svg"]').classList.toggle("disabled", !canSvg);
    menu.style.display = "block";
    const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : { left: 8, right: 8, top: 8, bottom: 8 };
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 80;
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  var settingsMenuEl = null;
  function buildSettingsMenu() {
    if (settingsMenuEl) return settingsMenuEl;
    settingsMenuEl = document.createElement("div");
    settingsMenuEl.className = "code-menu";
    settingsMenuEl.style.display = "none";
    settingsMenuEl.innerHTML = '<div class="code-menu-item" data-act="toggle-inspect"></div><div class="code-menu-sep"></div><div class="code-menu-item" data-act="mode-hover"></div><div class="code-menu-item" data-act="mode-measure"></div><div class="code-menu-item" data-act="mode-crop"></div><div class="code-menu-sep"></div><div class="code-menu-item" data-act="montage">Export gallery as grid (PNG)</div>';
    settingsMenuEl.addEventListener("click", (e) => {
      const item = e.target.closest(".code-menu-item");
      if (!item || item.classList.contains("disabled")) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      const act = item.getAttribute("data-act");
      if (act === "toggle-inspect") {
        hoverInspectEnabled = !hoverInspectEnabled;
        vscode.setState({ ...vscode.getState(), hoverInspect: hoverInspectEnabled });
        if (!hoverInspectEnabled) {
          if (inspectTipEl) inspectTipEl.style.display = "none";
          clearInspectOverlay();
        }
      } else if (act === "mode-hover") setInspectMode("hover");
      else if (act === "mode-measure") setInspectMode("measure");
      else if (act === "mode-crop") setInspectMode("crop");
      else if (act === "montage") {
        hideSettingsMenu();
        exportGridMontage();
        return;
      }
      updateSettingsMenu();
    });
    document.body.appendChild(settingsMenuEl);
    return settingsMenuEl;
  }
  function updateSettingsMenu() {
    if (!settingsMenuEl) return;
    const set = (act, text, on, disabled) => {
      const el = settingsMenuEl.querySelector('[data-act="' + act + '"]');
      if (!el) return;
      el.textContent = (on ? "\u2713 " : "    ") + text;
      el.classList.toggle("disabled", !!disabled);
    };
    set("toggle-inspect", "Hover to inspect", hoverInspectEnabled, false);
    const off = !hoverInspectEnabled;
    set("mode-hover", "Tool: read-out + crosshair", inspectMode === "hover", off);
    set("mode-measure", "Tool: measure distance", inspectMode === "measure", off);
    set("mode-crop", "Tool: zoom to region", inspectMode === "crop", off);
  }
  function hideSettingsMenu() {
    if (settingsMenuEl) settingsMenuEl.style.display = "none";
  }
  function toggleSettingsMenu(event) {
    if (event) event.stopPropagation();
    const menu = buildSettingsMenu();
    if (menu.style.display === "block") {
      hideSettingsMenu();
      return;
    }
    updateSettingsMenu();
    menu.style.display = "block";
    const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : { left: 8, right: 8, top: 8, bottom: 8 };
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 44;
    let left = rect.right - mw;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  function toggleCodeMenuToolbar(event) {
    if (event) event.stopPropagation();
    if (currentIndex < 0 || currentIndex >= plots.length) return;
    toggleCodeMenu(currentIndex, event);
  }
  function runCodeAction(act, index) {
    const plot = plots[index];
    if (!plot) return;
    const code = plot.code || "";
    const noCode = () => vscode.postMessage({ command: "info", text: "No source code captured for this plot" });
    switch (act) {
      case "copy":
        if (!code.trim()) return noCode();
        navigator.clipboard.writeText(code).then(
          () => vscode.postMessage({ command: "info", text: "Code copied to clipboard" }),
          () => vscode.postMessage({ command: "info", text: "Copy failed: clipboard access required" })
        );
        break;
      case "reveal":
        if (!code.trim()) return noCode();
        vscode.postMessage({ command: "reveal_code", code });
        break;
      case "run":
        if (!code.trim()) return noCode();
        vscode.postMessage({ command: "run_code", code });
        break;
      case "open":
        if (!plot.srcFile) {
          vscode.postMessage({ command: "info", text: "No source file captured for this plot" });
          return;
        }
        vscode.postMessage({ command: "open_source", file: plot.srcFile, line1: plot.srcLine1, line2: plot.srcLine2 });
        break;
    }
  }
  window.addEventListener("click", () => {
    hideCodeMenu();
    hideCopyMenu();
    hideSettingsMenu();
  });
  window.addEventListener("resize", () => {
    hideCodeMenu();
    hideCopyMenu();
    hideSettingsMenu();
  });
  document.addEventListener("scroll", () => {
    hideCodeMenu();
    hideCopyMenu();
    hideSettingsMenu();
  }, true);
  function toggleFavorite(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= plots.length) return;
    plots[index].isFavorite = !plots[index].isFavorite;
    vscode.setState({ ...vscode.getState(), plots });
    persistMeta();
    persistArchive();
    updatePlotList();
  }
  function toggleFavoriteFilter() {
    showOnlyFavorites = !showOnlyFavorites;
    const btn = document.getElementById("favoriteFilterBtn");
    if (showOnlyFavorites) {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z" /></svg>';
      btn.style.color = "#FFD700";
    } else {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" /></svg>';
      btn.style.color = "";
    }
    updatePlotList();
  }
  function showNoteDialog(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= plots.length) return;
    currentNoteIndex = index;
    const textarea = document.getElementById("noteTextarea");
    textarea.value = plots[index].note || "";
    document.getElementById("noteModal").classList.add("show");
    setTimeout(() => textarea.focus(), 100);
  }
  function closeNoteModal() {
    document.getElementById("noteModal").classList.remove("show");
    currentNoteIndex = -1;
  }
  function saveNote() {
    if (currentNoteIndex < 0 || currentNoteIndex >= plots.length) return;
    plots[currentNoteIndex].note = document.getElementById("noteTextarea").value.trim();
    vscode.setState({ ...vscode.getState(), plots });
    persistMeta();
    persistArchive();
    updatePlotList();
    closeNoteModal();
  }
  document.getElementById("noteModal").addEventListener("click", function(e) {
    if (e.target === this) closeNoteModal();
  });
  var pendingTextX = 0;
  var pendingTextY = 0;
  function showTextDialog() {
    const modal = document.getElementById("textModal");
    const input = document.getElementById("textInput");
    if (!modal || !input) return;
    input.value = "";
    modal.classList.add("show");
    setTimeout(() => input.focus(), 100);
  }
  function closeTextModal() {
    document.getElementById("textModal").classList.remove("show");
  }
  function confirmTextAnnotation() {
    const input = document.getElementById("textInput");
    const text = input.value.trim();
    if (text && activeCtx) {
      activeCtx.font = "bold 20px Inter, -apple-system, sans-serif";
      activeCtx.fillStyle = currentColor;
      activeCtx.fillText(text, pendingTextX, pendingTextY);
      saveAnnotationToHistory();
    }
    closeTextModal();
  }
  var textInput = document.getElementById("textInput");
  if (textInput) {
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmTextAnnotation();
      if (e.key === "Escape") closeTextModal();
    });
  }
  var textModal = document.getElementById("textModal");
  if (textModal) {
    textModal.addEventListener("click", function(e) {
      if (e.target === this) closeTextModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      nextPlot();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      previousPlot();
    } else if (e.key === "Escape" && isFullscreen) {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === "D" && e.ctrlKey && e.shiftKey) {
      const logEl = document.getElementById("debugLog");
      if (logEl) logEl.style.display = logEl.style.display === "none" ? "block" : "none";
    }
  });
  var isFullscreen = false;
  function toggleFullscreen() {
    const container = document.getElementById("plotContainer");
    const img = document.getElementById("plotImage");
    const sidebar = document.querySelector(".sidebar");
    const header = document.querySelector(".header");
    if (!isFullscreen) {
      Object.assign(container.style, { position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh", zIndex: "9999", background: "var(--bg-primary)", padding: "20px" });
      if (img) img.style.cursor = "zoom-out";
      if (sidebar) sidebar.style.display = "none";
      if (header) header.style.display = "none";
    } else {
      Object.assign(container.style, { position: "", top: "", left: "", width: "", height: "", zIndex: "", background: "", padding: "" });
      if (img) img.style.cursor = "grab";
      if (sidebar) sidebar.style.display = "";
      if (header) header.style.display = "";
    }
    isFullscreen = !isFullscreen;
  }
  var plotImage = document.getElementById("plotImage");
  if (plotImage) plotImage.addEventListener("dblclick", toggleFullscreen);
  refreshLayout();
  function saveState() {
    vscode.setState({
      ...vscode.getState(),
      currentIndex,
      isSplitMode,
      leftIndex,
      rightIndex,
      annotations: lastCanvasData.size > 0 ? Object.fromEntries(lastCanvasData) : void 0,
      plotZoom: plotZoom.size > 0 ? Object.fromEntries(plotZoom) : void 0,
      palette: paletteState
    });
  }
  function toggleSplitView() {
    if (plots.length < 2 && !isSplitMode) {
      vscode.postMessage({ command: "info", text: "You need at least two plots to use Split View." });
      return;
    }
    isSplitMode = !isSplitMode;
    document.body.classList.toggle("is-split-mode", isSplitMode);
    const splitBtn = document.getElementById("splitBtn");
    if (splitBtn) splitBtn.classList.toggle("split-active-btn", isSplitMode);
    const mainWrapper = document.getElementById("mainMediaWrapper");
    const splitContainer = document.getElementById("splitViewContainer");
    if (isSplitMode) {
      if (mainWrapper) mainWrapper.style.display = "none";
      if (splitContainer) splitContainer.style.display = "flex";
      if (leftIndex === -1 && plots.length > 0) leftIndex = currentIndex;
      if (rightIndex === -1 && plots.length > 1) {
        rightIndex = currentIndex === 0 ? 1 : currentIndex - 1;
      }
      setTimeout(initSplitDivider, 50);
      focusPane("left");
      if (leftIndex >= 0) {
        const leftUrl = plotUrls.get(plots[leftIndex].id);
        if (leftUrl) {
          document.getElementById("leftPlot").src = leftUrl;
          document.getElementById("leftMediaWrapper").style.display = "inline-flex";
          updatePlotDimensions("leftMediaWrapper");
        }
        restoreAnnotation(plots[leftIndex].id, "leftAnnotationCanvas");
      }
      if (rightIndex >= 0) {
        const rightUrl = plotUrls.get(plots[rightIndex].id);
        if (rightUrl) {
          document.getElementById("rightPlot").src = rightUrl;
          document.getElementById("rightMediaWrapper").style.display = "inline-flex";
          updatePlotDimensions("rightMediaWrapper");
        }
        restoreAnnotation(plots[rightIndex].id, "rightAnnotationCanvas");
      }
    } else {
      if (splitContainer) splitContainer.style.display = "none";
      if (mainWrapper) {
        mainWrapper.style.display = "inline-flex";
        updatePlotDimensions("mainMediaWrapper");
      }
      showPlot(currentIndex, true);
    }
    updatePlotList();
    updateControls();
    saveState();
  }
  function initSplitDivider() {
    const divider = document.getElementById("splitDivider");
    const leftPane = document.getElementById("leftPane");
    const container = document.getElementById("splitViewContainer");
    if (!divider || !container || !leftPane) return;
    divider.onmousedown = (e) => {
      isDraggingDivider = true;
      divider.classList.add("active");
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    };
    const handleMouseMove = (e) => {
      if (!isDraggingDivider) return;
      const containerRect = container.getBoundingClientRect();
      let percentage = (e.clientX - containerRect.left) / containerRect.width * 100;
      percentage = Math.max(15, Math.min(85, percentage));
      leftPane.style.flex = `0 0 ${percentage}%`;
      updatePlotDimensions("leftMediaWrapper");
      updatePlotDimensions("rightMediaWrapper");
    };
    const handleMouseUp = () => {
      if (isDraggingDivider) {
        isDraggingDivider = false;
        divider.classList.remove("active");
        document.body.style.cursor = "default";
        setTimeout(() => {
          const oldActive = activePane;
          activePane = "left";
          sendResizeEvent();
          activePane = "right";
          sendResizeEvent();
          activePane = oldActive;
        }, 50);
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }
  function setSplitPosition(index, side, event) {
    if (event) event.stopPropagation();
    if (side === "left") {
      leftIndex = index;
    } else {
      rightIndex = index;
    }
    currentIndex = index;
    activePane = side;
    const plot = plots[index];
    const paneImg = document.getElementById(side === "left" ? "leftPlot" : "rightPlot");
    const paneLabel = document.getElementById(side === "left" ? "leftPaneLabel" : "rightPaneLabel");
    if (paneLabel) paneLabel.textContent = "Plot " + (index + 1);
    if (paneImg) {
      if (plotUrls.has(plot.id)) {
        paneImg.src = plotUrls.get(plot.id);
        restoreAnnotation(plot.id, side === "left" ? "leftAnnotationCanvas" : "rightAnnotationCanvas");
      } else {
        broadcastToBackends({ type: "request_binary", plot_id: plot.id });
      }
    }
    focusPane(side);
    saveState();
  }
  function focusPane(side) {
    if (!isSplitMode) return;
    activePane = side;
    document.querySelectorAll(".split-pane").forEach((p) => p.classList.remove("focused"));
    const pane = document.getElementById(side + "Pane");
    if (pane) pane.classList.add("focused");
    const newIndex = side === "left" ? leftIndex : rightIndex;
    if (newIndex !== -1) {
      currentIndex = newIndex;
      updateControls();
      updatePlotList();
    }
  }
  function showZoomNotification(zoomLevel) {
    const notification = document.getElementById("zoomNotification");
    if (!notification) return;
    notification.textContent = zoomLevel === "fit" ? "Fit" : zoomLevel + "%";
    notification.classList.add("show");
    setTimeout(() => notification.classList.remove("show"), 1500);
  }
  function toggleAnnotationMode() {
    isAnnotating = !isAnnotating;
    document.body.classList.toggle("is-annotating", isAnnotating);
    const annotateBtn = document.getElementById("annotateBtn");
    if (annotateBtn) annotateBtn.classList.toggle("annotate-active-btn", isAnnotating);
    const palette = document.getElementById("drawPalette");
    if (palette) {
      palette.style.display = isAnnotating ? "flex" : "none";
      if (isAnnotating) {
        applyPaletteState(true);
        initPaletteDrag();
        updatePaletteScaling();
      }
    }
    if (isAnnotating) {
      setupActiveCanvas();
    } else {
      updatePlotList();
    }
  }
  var orientationSwitchTimer = null;
  function togglePaletteOrientation() {
    const palette = document.getElementById("drawPalette");
    if (palette) {
      palette.classList.add("no-transition");
      palette.classList.add("is-switching");
      if (orientationSwitchTimer) {
        clearTimeout(orientationSwitchTimer);
      }
      orientationSwitchTimer = setTimeout(() => {
        palette.classList.remove("is-switching");
        orientationSwitchTimer = null;
      }, 1500);
    }
    paletteState.isHorizontal = !paletteState.isHorizontal;
    if (palette) {
      palette.classList.toggle("palette-horizontal", paletteState.isHorizontal);
    }
    applyPaletteState(true);
    if (palette) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          palette.classList.remove("no-transition");
        });
      });
    }
    saveState();
  }
  function applyPaletteState(immediate = false) {
    const palette = document.getElementById("drawPalette");
    if (!palette) return;
    palette.classList.toggle("palette-horizontal", paletteState.isHorizontal);
    const container = palette.parentElement;
    if (container) {
      const updatePos = () => {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          palette.style.left = paletteState.x + "px";
          palette.style.top = paletteState.y + "px";
          return;
        }
        const _reflow = palette.offsetHeight;
        const pRect = palette.getBoundingClientRect();
        const clampedX = Math.max(4, Math.min(paletteState.x, rect.width - pRect.width - 4));
        const clampedY = Math.max(4, Math.min(paletteState.y, rect.height - pRect.height - 4));
        palette.style.left = clampedX + "px";
        palette.style.top = clampedY + "px";
      };
      if (immediate) {
        updatePos();
      } else {
        requestAnimationFrame(updatePos);
      }
    } else {
      palette.style.left = paletteState.x + "px";
      palette.style.top = paletteState.y + "px";
    }
  }
  function initPaletteDrag() {
    const palette = document.getElementById("drawPalette");
    const handle = document.getElementById("paletteHandle");
    if (!palette || !handle || palette.hasDragListener) return;
    let isPaletteDragging = false;
    let offsetX, offsetY;
    handle.addEventListener("mousedown", (e) => {
      isPaletteDragging = true;
      palette.classList.add("is-dragging");
      const rect = palette.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      palette.style.opacity = "0.9";
      e.stopPropagation();
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!isPaletteDragging) return;
      const container = palette.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      let x = e.clientX - rect.left - offsetX;
      let y = e.clientY - rect.top - offsetY;
      const padding = 4;
      x = Math.max(padding, Math.min(x, rect.width - palette.offsetWidth - padding));
      y = Math.max(padding, Math.min(y, rect.height - palette.offsetHeight - padding));
      paletteState.x = x;
      paletteState.y = y;
      palette.style.left = x + "px";
      palette.style.top = y + "px";
    });
    window.addEventListener("mouseup", () => {
      if (isPaletteDragging) {
        isPaletteDragging = false;
        palette.classList.remove("is-dragging");
        palette.style.opacity = "1";
        saveState();
      }
    });
    palette.hasDragListener = true;
  }
  function renderState(dataUrl) {
    if (!activeCtx || !activeCanvas) return;
    activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      activeCtx.drawImage(img, 0, 0, activeCanvas.width, activeCanvas.height);
    };
    img.src = dataUrl;
  }
  function undoAnnotation() {
    if (!isAnnotating) return;
    const pid = isSplitMode ? activePane === "left" ? plots[leftIndex]?.id : plots[rightIndex]?.id : plots[currentIndex]?.id;
    if (!pid) return;
    if (!annotationHistory.canUndo(pid)) return;
    const currentState = activeCanvas.toDataURL();
    const prevState = annotationHistory.undo(pid, currentState);
    renderState(prevState);
    lastCanvasData.set(String(pid), prevState);
    saveState();
  }
  function redoAnnotation() {
    if (!isAnnotating) return;
    const pid = isSplitMode ? activePane === "left" ? plots[leftIndex]?.id : plots[rightIndex]?.id : plots[currentIndex]?.id;
    if (!pid) return;
    if (!annotationHistory.canRedo(pid)) return;
    const currentState = activeCanvas.toDataURL();
    const nextState = annotationHistory.redo(pid, currentState);
    renderState(nextState);
    lastCanvasData.set(String(pid), nextState);
    saveState();
  }
  function updatePaletteScaling() {
    const palette = document.getElementById("drawPalette");
    const container = document.getElementById("plotContainer");
    if (!palette || !container || !isAnnotating) return;
    const scale = paletteScale(container.clientWidth, container.clientHeight);
    palette.style.transform = `scale(${scale})`;
  }
  function setupActiveCanvas() {
    let canvasId = isSplitMode ? activePane + "AnnotationCanvas" : "annotationCanvas";
    activeCanvas = document.getElementById(canvasId);
    if (activeCanvas) {
      const container = activeCanvas.parentElement;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      if (activeCanvas.width !== newW || activeCanvas.height !== newH) {
        activeCanvas.width = newW;
        activeCanvas.height = newH;
      }
      activeCtx = activeCanvas.getContext("2d");
      const pid = isSplitMode ? activePane === "left" ? plots[leftIndex]?.id : plots[rightIndex]?.id : plots[currentIndex]?.id;
      if (pid) {
        restoreAnnotation(pid, canvasId);
      }
      if (!activeCanvas.hasListener) {
        activeCanvas.addEventListener("mousedown", handleDrawStart);
        activeCanvas.addEventListener("mousemove", handleDrawMove);
        window.addEventListener("mouseup", handleDrawEnd);
        activeCanvas.hasListener = true;
      }
    }
  }
  function setDrawTool(tool) {
    currentTool = tool;
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById("tool-" + tool).classList.add("active");
  }
  function setDrawColor(color) {
    currentColor = color;
    document.querySelectorAll(".color-swatch").forEach((s) => {
      s.classList.remove("active");
      s.style.borderColor = "white";
    });
    const presets = {
      "#ff4757": "color-red",
      "#2ed573": "color-green",
      "#1e90ff": "color-blue",
      "#ffa502": "color-orange",
      "#ffffff": "color-white"
    };
    const id = presets[color.toLowerCase()];
    if (id) {
      const swatch = document.getElementById(id);
      if (swatch) {
        swatch.classList.add("active");
        swatch.style.borderColor = color;
      }
      const customSwatch = document.getElementById("color-custom");
      if (customSwatch) customSwatch.style.background = "#ffffff";
    } else {
      const customSwatch = document.getElementById("color-custom");
      if (customSwatch) {
        customSwatch.classList.add("active");
        customSwatch.style.background = color;
        customSwatch.style.borderColor = color;
      }
    }
  }
  function triggerCustomColor() {
    const picker = document.getElementById("customColorPicker");
    if (picker) {
      picker.click();
    }
  }
  function initCustomColorPicker() {
    const picker = document.getElementById("customColorPicker");
    if (picker) {
      picker.addEventListener("input", (e) => {
        setDrawColor(e.target.value);
      });
      picker.addEventListener("change", (e) => {
        setDrawColor(e.target.value);
        saveState();
      });
    }
  }
  var startImageData = null;
  var startX = 0;
  var startY = 0;
  function handleDrawStart(e) {
    if (!isAnnotating || !activeCtx || !activeCanvas) return;
    isDrawing = true;
    const rect = activeCanvas.getBoundingClientRect();
    const p = toCanvasCoords(e.clientX, e.clientY, rect, activeCanvas.width, activeCanvas.height);
    startX = p.x;
    startY = p.y;
    startImageData = activeCtx.getImageData(0, 0, activeCanvas.width, activeCanvas.height);
    activeCtx.beginPath();
    activeCtx.moveTo(startX, startY);
    activeCtx.strokeStyle = currentColor;
    activeCtx.fillStyle = currentColor;
    activeCtx.lineWidth = 3;
    activeCtx.lineCap = "round";
  }
  function handleDrawMove(e) {
    if (!isDrawing || !activeCtx || !activeCanvas) return;
    const rect = activeCanvas.getBoundingClientRect();
    const pos = toCanvasCoords(e.clientX, e.clientY, rect, activeCanvas.width, activeCanvas.height);
    const currX = pos.x;
    const currY = pos.y;
    if (currentTool === "pencil") {
      activeCtx.lineTo(currX, currY);
      activeCtx.stroke();
    } else if (currentTool === "arrow") {
      activeCtx.putImageData(startImageData, 0, 0);
      drawArrow(activeCtx, startX, startY, currX, currY);
    }
  }
  function handleDrawEnd(e) {
    if (!isDrawing) return;
    isDrawing = false;
    const rect = activeCanvas.getBoundingClientRect();
    const pos = toCanvasCoords(e.clientX, e.clientY, rect, activeCanvas.width, activeCanvas.height);
    const currX = pos.x;
    const currY = pos.y;
    if (currentTool === "text") {
      pendingTextX = startX;
      pendingTextY = startY;
      showTextDialog();
      return;
    }
    saveAnnotationToHistory();
  }
  function drawArrow(ctx, fromX, fromY, toX, toY) {
    const g = arrowGeometry(fromX, fromY, toX, toY);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(g.lineEndX, g.lineEndY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.tipX, g.tipY);
    ctx.lineTo(g.leftX, g.leftY);
    ctx.lineTo(g.rightX, g.rightY);
    ctx.closePath();
    ctx.fill();
  }
  function saveAnnotationToHistory() {
    if (!activeCanvas || plots.length === 0) return;
    const pid = isSplitMode ? activePane === "left" ? plots[leftIndex]?.id : plots[rightIndex]?.id : plots[currentIndex]?.id;
    if (pid) {
      const prevState = lastCanvasData.get(String(pid)) || "";
      annotationHistory.commit(pid, prevState);
      lastCanvasData.set(String(pid), activeCanvas.toDataURL());
      saveState();
    }
  }
  function clearAnnotations() {
    if (!activeCtx || !activeCanvas) return;
    const pid = isSplitMode ? activePane === "left" ? plots[leftIndex]?.id : plots[rightIndex]?.id : plots[currentIndex]?.id;
    if (pid) {
      const prevState = lastCanvasData.get(String(pid)) || "";
      annotationHistory.commit(pid, prevState);
      activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
      lastCanvasData.delete(String(pid));
      saveState();
    }
  }
  function restoreAnnotation(plotId, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const container = canvas.parentElement;
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    const data = lastCanvasData.get(String(plotId));
    if (data) {
      const img = new Image();
      canvas.pendingSource = data;
      img.onload = () => {
        if (canvas.pendingSource === data) {
          ctx.drawImage(img, 0, 0, w, h);
          delete canvas.pendingSource;
        }
      };
      img.src = data;
    }
  }
  window.addEventListener("resize", () => {
    updatePaletteScaling();
    if (isSplitMode) {
      if (leftIndex >= 0) restoreAnnotation(plots[leftIndex].id, "leftAnnotationCanvas");
      if (rightIndex >= 0) restoreAnnotation(plots[rightIndex].id, "rightAnnotationCanvas");
    } else if (currentIndex >= 0 && plots[currentIndex]) {
      restoreAnnotation(plots[currentIndex].id, "annotationCanvas");
    }
  });
  function getCombinedPlotBlob(plot, callback, opts = {}) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const natW = img.naturalWidth || 800;
      const natH = img.naturalHeight || 600;
      const { cw, ch, dx, dy, dw, dh } = computeExportCanvas(natW, natH, opts);
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, dx, dy, dw, dh);
      const annotationData = lastCanvasData.get(String(plot.id));
      if (annotationData) {
        const annoImg = new Image();
        annoImg.onload = () => {
          ctx.drawImage(annoImg, dx, dy, dw, dh);
          canvas.toBlob(callback, "image/png", 0.95);
        };
        annoImg.onerror = () => {
          log("Annotation image load failed");
          canvas.toBlob(callback, "image/png", 0.95);
        };
        annoImg.src = annotationData;
      } else {
        canvas.toBlob(callback, "image/png", 0.95);
      }
    };
    img.onerror = () => {
      log("Base plot image load failed");
      callback(null);
    };
    img.src = plot.data;
  }
  async function getSplitCombinedBlob(plotL, plotR, callback, opts = {}) {
    const loadImg = (url) => new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
    try {
      const [imgL, imgR] = await Promise.all([loadImg(plotL.data), loadImg(plotR.data)]);
      const scale = opts.scale || 2;
      const layout = computeSplitCanvas(
        imgL.naturalWidth,
        imgL.naturalHeight,
        imgR.naturalWidth,
        imgR.naturalHeight,
        scale
      );
      const { left: L, right: R } = layout;
      const canvas = document.createElement("canvas");
      canvas.width = layout.canvasW;
      canvas.height = layout.canvasH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(imgL, L.x, L.y, L.w, L.h);
      const annoL = lastCanvasData.get(String(plotL.id));
      if (annoL) await drawAnno(ctx, annoL, L.x, L.y, L.w, L.h);
      ctx.drawImage(imgR, R.x, R.y, R.w, R.h);
      const annoR = lastCanvasData.get(String(plotR.id));
      if (annoR) await drawAnno(ctx, annoR, R.x, R.y, R.w, R.h);
      canvas.toBlob(callback, "image/png", 0.95);
    } catch (e) {
      log("Split PNG generation failed: " + e);
      callback(null);
    }
  }
  async function drawAnno(ctx, data, x, y, w, h) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, x, y, w, h);
        res();
      };
      img.onerror = () => res();
      img.src = data;
    });
  }
  async function generateSplitCompositeSVG(plotL, plotR) {
    try {
      const fetchBase64 = async (url) => {
        const r = await fetch(url);
        const blob = await r.blob();
        return new Promise((res) => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result);
          reader.readAsDataURL(blob);
        });
      };
      const loadSize = (url) => new Promise((res) => {
        const img = new Image();
        img.onload = () => res({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
        img.onerror = () => res({ w: 800, h: 600 });
        img.src = url;
      });
      const [dataL, dataR, sizeL, sizeR] = await Promise.all([
        fetchBase64(plotL.data),
        fetchBase64(plotR.data),
        loadSize(plotL.data),
        loadSize(plotR.data)
      ]);
      const annoL = lastCanvasData.get(String(plotL.id)) || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      const annoR = lastCanvasData.get(String(plotR.id)) || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      const totalW = sizeL.w + sizeR.w;
      const totalH = Math.max(sizeL.h, sizeR.h);
      const svg = `
<svg width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(0, ${(totalH - sizeL.h) / 2})">
        <image href="${dataL}" width="${sizeL.w}" height="${sizeL.h}" />
        <image href="${annoL}" width="${sizeL.w}" height="${sizeL.h}" />
    </g>
    <g transform="translate(${sizeL.w}, ${(totalH - sizeR.h) / 2})">
        <image href="${dataR}" width="${sizeR.w}" height="${sizeR.h}" />
        <image href="${annoR}" width="${sizeR.w}" height="${sizeR.h}" />
    </g>
</svg>`.trim();
      return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    } catch (e) {
      log("Split SVG generation failed: " + e);
      return null;
    }
  }
  var sidebarState = typeof state.sidebarHidden === "boolean" ? state.sidebarHidden : false;
  var sidebarEl = document.querySelector(".sidebar");
  if (sidebarEl) {
    sidebarEl.classList.toggle("sidebar-hidden", sidebarState);
  }
  if (isDarkMode) {
    document.body.classList.add("dark-mode");
  }
  updateDarkModeUI();
  new MutationObserver(() => {
    if (darkModeUserSet) return;
    const shouldDark = detectVsCodeDark();
    if (shouldDark !== isDarkMode) {
      isDarkMode = shouldDark;
      document.body.classList.toggle("dark-mode", isDarkMode);
      updateDarkModeUI();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  refreshLayout();
  setDrawColor(currentColor);
  initCustomColorPicker();
  initHoverInspect();
  window.addEventListener("keydown", (e) => {
    if (isAnnotating) {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z") {
          e.preventDefault();
          undoAnnotation();
        } else if (e.key === "y" || e.shiftKey && e.key === "z") {
          e.preventDefault();
          redoAnnotation();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        toggleAnnotationMode();
      }
      return;
    }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        previousPlot();
        break;
      case "ArrowRight":
        e.preventDefault();
        nextPlot();
        break;
      case "a":
      case "A":
        e.preventDefault();
        toggleAnnotationMode();
        break;
      case "e":
      case "E":
        e.preventDefault();
        exportPlot();
        break;
      case "d":
      case "D":
        e.preventDefault();
        toggleDarkMode();
        break;
    }
  });
  vscode.postMessage({ command: "request_config" });
  vscode.postMessage({ command: "request_meta" });
  vscode.postMessage({ command: "request_archive" });
  setTimeout(() => {
    document.body.style.opacity = "1";
  }, 50);
  Object.assign(window, {
    clearAllPlots,
    clearAnnotations,
    closeNoteModal,
    closeTextModal,
    confirmTextAnnotation,
    copyToClipboard,
    copySvgToClipboard,
    toggleCopyMenu,
    toggleSettingsMenu,
    openDiffView,
    closeDiffModal,
    computeDiff,
    deletePlot,
    exportPlot,
    focusPane,
    handleDragEnd,
    handleDragStart,
    nextPlot,
    openInNewWindow,
    previousPlot,
    redoAnnotation,
    saveNote,
    setDrawColor,
    setDrawTool,
    setSplitPosition,
    showNoteDialog,
    showPlot,
    toggleAnnotationMode,
    toggleAspectRatio,
    toggleCodeMenuToolbar,
    toggleDarkMode,
    toggleFavorite,
    toggleFavoriteFilter,
    togglePaletteOrientation,
    toggleSidebar,
    toggleSplitView,
    toggleZoom,
    triggerCustomColor,
    undoAnnotation
  });
})();
