// Barrel entry bundled by esbuild into webview/vendor/rplot-core.js as the global
// `RPlotCore`, so the (still classic-script) webview main.js can consume the typed,
// unit-tested core logic via window.RPlotCore.
export { ReconnectManager } from './reconnect';
export type { ReconnectOptions, TimerHandle } from './reconnect';
export { mergePlotLists, idNum } from './archive';
export type { PlotLike } from './archive';
export { aspectRatio, computePlotDimensions, computeExportCanvas, paletteScale, computeSplitCanvas } from './geometry';
export type { Aspect, PlotDimensions, ExportOpts, ExportCanvas, Box, SplitCanvas } from './geometry';
export { toCanvasCoords, arrowGeometry } from './annotation';
export type { RectLike, Point, ArrowGeometry } from './annotation';
export { AnnotationHistory } from './history';
export { sniffImageMime } from './format';
export type { ImageMime } from './format';
export { diffPixels } from './diff';
export type { DiffOptions, DiffResult } from './diff';
export { dataAtPixel, formatInspectValue, panelPixelRect } from './inspect';
export type { PlotCoords } from './inspect';
