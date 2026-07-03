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

// Compact, human-readable formatting for a hovered value.
export function formatInspectValue(v: number): string {
    if (!isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
    return String(Number(v.toPrecision(5)));
}
