// Pure pixel-diff of two RGBA buffers (same length), used by the plot diff view. The
// webview rasterises both plots onto canvases of identical size and hands the raw
// ImageData here; this stays free of the DOM so it can be unit-tested.

export interface DiffOptions {
    // Per-channel tolerance (0..255). A pixel counts as changed when any of R/G/B
    // differs by more than this, which lets anti-aliasing noise be ignored.
    threshold?: number;
    // RGB colour painted over changed pixels (default magenta).
    highlight?: [number, number, number];
    // How strongly unchanged pixels keep their original luminance (0 = pure white,
    // 1 = original grayscale). Lower values make highlights pop.
    fade?: number;
}

export interface DiffResult {
    out: Uint8ClampedArray; // RGBA result, same length as the inputs
    changed: number;        // number of changed pixels
    total: number;          // total pixels compared
}

export function diffPixels(a: ArrayLike<number>, b: ArrayLike<number>, opts: DiffOptions = {}): DiffResult {
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
            // Dim the first image toward white so the magenta changes stand out.
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
