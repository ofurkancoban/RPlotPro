import * as assert from 'assert';
import { dataAtPixel, formatInspectValue, panelPixelRect, pixelAtData, nearestPoint, PlotCoords } from './inspect';

// Panel fills the whole image (plt = 0..1), data range x:0..10, y:0..100.
const full: PlotCoords = { usr: [0, 10, 0, 100], plt: [0, 1, 0, 1] };

suite('dataAtPixel', () => {
    test('centre of a full-panel image maps to the range midpoint', () => {
        const d = dataAtPixel(50, 50, 100, 100, full)!;
        assert.strictEqual(d.x, 5);
        assert.strictEqual(d.y, 50); // top-left is high y, so centre is mid
    });

    test('y axis is inverted (top of image is the max data y)', () => {
        assert.strictEqual(dataAtPixel(0, 0, 100, 100, full)!.y, 100);
        assert.strictEqual(dataAtPixel(0, 100, 100, 100, full)!.y, 0);
    });

    test('respects panel margins (plt) so margin pixels return null', () => {
        // Panel occupies the inner 10%..90% in both axes.
        const c: PlotCoords = { usr: [0, 10, 0, 10], plt: [0.1, 0.9, 0.1, 0.9] };
        assert.strictEqual(dataAtPixel(5, 5, 100, 100, c), null); // in the margin
        const d = dataAtPixel(50, 50, 100, 100, c)!;               // panel centre
        assert.strictEqual(d.x, 5);
        assert.strictEqual(d.y, 5);
    });

    test('log axes exponentiate the interpolated user coordinate', () => {
        // usr for a log axis holds log10 limits (10^1 .. 10^3).
        const c: PlotCoords = { usr: [1, 3, 0, 1], plt: [0, 1, 0, 1], xlog: true };
        assert.strictEqual(dataAtPixel(0, 0, 100, 100, c)!.x, 10);
        assert.strictEqual(dataAtPixel(100, 0, 100, 100, c)!.x, 1000);
    });

    test('returns null for missing coords or zero-size image', () => {
        assert.strictEqual(dataAtPixel(1, 1, 0, 100, full), null);
        assert.strictEqual(dataAtPixel(1, 1, 100, 100, undefined as any), null);
    });
});

suite('panelPixelRect', () => {
    test('full-panel plt covers the whole image', () => {
        const r = panelPixelRect(200, 100, full)!;
        assert.deepStrictEqual(r, { left: 0, right: 200, top: 0, bottom: 100 });
    });
    test('margins map to inset pixels with an inverted top/bottom', () => {
        const c: PlotCoords = { usr: [0, 1, 0, 1], plt: [0.1, 0.9, 0.2, 0.8] };
        const r = panelPixelRect(100, 100, c)!;
        const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
        near(r.left, 10);
        near(r.right, 90);
        near(r.top, 20);   // (1 - 0.8) * 100
        near(r.bottom, 80); // (1 - 0.2) * 100
    });
});

suite('pixelAtData / nearestPoint', () => {
    test('pixelAtData is the inverse of dataAtPixel', () => {
        const p = pixelAtData(5, 50, 100, 100, full)!; // centre of 0..10, 0..100
        assert.strictEqual(p.px, 50);
        assert.strictEqual(p.py, 50);
        const back = dataAtPixel(p.px, p.py, 100, 100, full)!;
        assert.strictEqual(back.x, 5);
        assert.strictEqual(back.y, 50);
    });

    test('snaps to the nearest point within the pixel radius', () => {
        const xs = [1, 5, 9], ys = [10, 50, 90];
        // Cursor near the middle point (5,50) -> pixel (50,50).
        const hit = nearestPoint(52, 48, xs, ys, 100, 100, full, 18)!;
        assert.strictEqual(hit.index, 1);
        assert.strictEqual(hit.x, 5);
        assert.strictEqual(hit.y, 50);
    });

    test('returns null when no point is close enough', () => {
        const xs = [1], ys = [10]; // pixel (10, 90)
        assert.strictEqual(nearestPoint(50, 50, xs, ys, 100, 100, full, 18), null);
    });
});

suite('formatInspectValue', () => {
    test('trims to significant digits for normal magnitudes', () => {
        assert.strictEqual(formatInspectValue(5), '5');
        assert.strictEqual(formatInspectValue(3.14159265), '3.1416');
    });
    test('uses exponential for very large or very small values', () => {
        assert.strictEqual(formatInspectValue(123456), '1.23e+5');
        assert.strictEqual(formatInspectValue(0.0001), '1.00e-4');
    });
});
