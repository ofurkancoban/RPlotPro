// Pure geometry for the webview: plot sizing inside the viewer and canvas sizing
// for export. Extracted so the math is typed and unit-testable without a DOM.

export type Aspect = 'auto' | 'square' | 'landscape' | 'portrait' | 'fill' | string;

// Width/height ratio for a named aspect; 0 means auto/fill (no strict ratio).
export function aspectRatio(aspect: Aspect): number {
    if (aspect === 'square') return 1;
    if (aspect === 'landscape') return 4 / 3;
    if (aspect === 'portrait') return 3 / 4;
    return 0;
}

export interface PlotDimensions {
    width: number;
    height: number;
    fitsW: boolean;
    fitsH: boolean;
}

// Target size of a plot inside a container for a given zoom ('fit' | '50'..'200')
// and aspect. 'fit' fills the largest box of the aspect that fits; a numeric zoom
// scales that base-fit size by percent.
export function computePlotDimensions(
    zoom: string,
    aspect: Aspect,
    containerW: number,
    containerH: number
): PlotDimensions {
    const ratio = aspectRatio(aspect);

    let fitW: number;
    let fitH: number;
    if (ratio === 0) {
        fitW = containerW;
        fitH = containerH;
    } else if (containerW / containerH > ratio) {
        // Container wider than the aspect: constrain by height.
        fitH = containerH;
        fitW = containerH * ratio;
    } else {
        // Container taller than the aspect: constrain by width.
        fitW = containerW;
        fitH = containerW / ratio;
    }

    let width: number;
    let height: number;
    if (zoom === 'fit') {
        width = fitW;
        height = fitH;
    } else {
        const factor = parseInt(String(zoom), 10) / 100;
        width = fitW * factor;
        height = fitH * factor;
    }

    return { width, height, fitsW: width <= containerW, fitsH: height <= containerH };
}

export interface ExportOpts {
    scale?: number;
    width?: number;
    height?: number;
}

export interface ExportCanvas {
    cw: number;
    ch: number;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
}

// Canvas size + draw rectangle for exporting a plot. Fixed width/height letterbox
// the image (preserve aspect, centre on white); otherwise a scale factor acts as a
// DPI multiplier (default 2x).
export function computeExportCanvas(natW: number, natH: number, opts: ExportOpts = {}): ExportCanvas {
    if (opts.width && opts.height) {
        const cw = opts.width;
        const ch = opts.height;
        const r = Math.min(cw / natW, ch / natH);
        const dw = natW * r;
        const dh = natH * r;
        return { cw, ch, dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
    }
    const scale = opts.scale || 2;
    const cw = natW * scale;
    const ch = natH * scale;
    return { cw, ch, dx: 0, dy: 0, dw: cw, dh: ch };
}

// Auto-scale factor for the annotation palette so it stays usable in a small viewer.
export function paletteScale(containerW: number, containerH: number): number {
    if (containerW < 400 || containerH < 400) {
        return Math.max(0.6, Math.min(containerW / 500, containerH / 500));
    }
    return 1.0;
}

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SplitCanvas {
    canvasW: number;
    canvasH: number;
    left: Box;
    right: Box;
}

// Side-by-side split-export layout: two plots drawn at `scale`, vertically centred
// on a white canvas as wide as both and as tall as the taller one.
export function computeSplitCanvas(
    natWL: number,
    natHL: number,
    natWR: number,
    natHR: number,
    scale = 2
): SplitCanvas {
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
