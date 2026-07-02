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
    idNum: () => idNum,
    mergePlotLists: () => mergePlotLists
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
  return __toCommonJS(src_exports);
})();
