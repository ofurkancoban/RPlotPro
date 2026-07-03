// Map a pixel on a rendered plot back to data coordinates, using the base-graphics
// coordinate system the R server captured (par("usr") + par("plt")). Pure so it can be
// unit-tested; the webview supplies the cursor position and the image's displayed size.

export interface PlotCoords {
    usr: [number, number, number, number]; // x1, x2, y1, y2 in (possibly log10) user units
    plt: [number, number, number, number]; // left, right, bottom, top as fractions of the figure
    xlog?: boolean;
    ylog?: boolean;
}

// px, py are relative to the image's top-left; w, h are its displayed size. Because usr
// and plt are scale-independent (data units and fractions), displayed vs natural size
// does not matter. Returns null when the cursor is outside the plotting panel.
export function dataAtPixel(
    px: number, py: number, w: number, h: number, c: PlotCoords
): { x: number; y: number } | null {
    if (!c || !c.usr || !c.plt || w <= 0 || h <= 0) return null;

    const fx = px / w;
    const fyBottom = 1 - py / h; // R device space is bottom-up

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

// Inverse of dataAtPixel: where a data point lands in pixels. Used to snap hover to the
// nearest plotted point.
export function pixelAtData(x: number, y: number, w: number, h: number, c: PlotCoords):
    { px: number; py: number } | null {
    if (!c || !c.usr || !c.plt || w <= 0 || h <= 0) return null;
    const ux = c.xlog ? Math.log10(x) : x;
    const uy = c.ylog ? Math.log10(y) : y;
    const [x1, x2, y1, y2] = c.usr;
    const [l, r, b, t] = c.plt;
    const fx = l + ((ux - x1) / (x2 - x1)) * (r - l);
    const fyBottom = b + ((uy - y1) / (y2 - y1)) * (t - b);
    return { px: fx * w, py: (1 - fyBottom) * h };
}

// Nearest plotted point to a pixel, within maxDistPx (in pixels). Returns its index and
// exact data value, or null if none is close enough.
export function nearestPoint(
    px: number, py: number, xs: ArrayLike<number>, ys: ArrayLike<number>,
    w: number, h: number, c: PlotCoords, maxDistPx = 18
): { index: number; x: number; y: number; px: number; py: number } | null {
    if (!c || !xs || !ys) return null;
    const n = Math.min(xs.length, ys.length);
    let best = -1, bestD = maxDistPx * maxDistPx, bpx = 0, bpy = 0;
    for (let i = 0; i < n; i++) {
        const p = pixelAtData(xs[i], ys[i], w, h, c);
        if (!p) continue;
        const dx = p.px - px, dy = p.py - py, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; bpx = p.px; bpy = p.py; }
    }
    if (best < 0) return null;
    return { index: best, x: xs[best], y: ys[best], px: bpx, py: bpy };
}

// Pixel bounds of the plotting panel (inside the axis margins), from par("plt").
// Used to draw axis-projection lines and to clamp region selection to the panel.
export function panelPixelRect(w: number, h: number, c: PlotCoords):
    { left: number; right: number; top: number; bottom: number } | null {
    if (!c || !c.plt || w <= 0 || h <= 0) return null;
    const [l, r, b, t] = c.plt;
    return {
        left: l * w,
        right: r * w,
        top: (1 - t) * h,    // plt top is a fraction from the bottom; pixels grow downward
        bottom: (1 - b) * h
    };
}

// Compact, human-readable formatting for a hovered value.
export function formatInspectValue(v: number): string {
    if (!isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
    return String(Number(v.toPrecision(5)));
}
