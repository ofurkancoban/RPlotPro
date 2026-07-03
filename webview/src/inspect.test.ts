import * as assert from 'assert';
import { dataAtPixel, formatInspectValue, PlotCoords } from './inspect';

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
