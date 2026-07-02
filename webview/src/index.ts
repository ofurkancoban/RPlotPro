// Barrel entry bundled by esbuild into webview/vendor/rplot-core.js as the global
// `RPlotCore`, so the (still classic-script) webview main.js can consume the typed,
// unit-tested core logic via window.RPlotCore.
export { ReconnectManager } from './reconnect';
export type { ReconnectOptions, TimerHandle } from './reconnect';
export { mergePlotLists, idNum } from './archive';
export type { PlotLike } from './archive';
export { aspectRatio, computePlotDimensions, computeExportCanvas } from './geometry';
export type { Aspect, PlotDimensions, ExportOpts, ExportCanvas } from './geometry';
