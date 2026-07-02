"use strict";
var RPlotCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // webview/src/index.ts
  var src_exports = {};
  __export(src_exports, {
    ReconnectManager: () => ReconnectManager,
    arrowGeometry: () => arrowGeometry,
    aspectRatio: () => aspectRatio,
    computeExportCanvas: () => computeExportCanvas,
    computePlotDimensions: () => computePlotDimensions,
    idNum: () => idNum,
    mergePlotLists: () => mergePlotLists,
    toCanvasCoords: () => toCanvasCoords
  });

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
  return __toCommonJS(src_exports);
})();
