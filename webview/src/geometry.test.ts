import * as assert from 'assert';
import { aspectRatio, computePlotDimensions, computeExportCanvas } from './geometry';

suite('aspectRatio', () => {
    test('named aspects', () => {
        assert.strictEqual(aspectRatio('square'), 1);
        assert.strictEqual(aspectRatio('landscape'), 4 / 3);
        assert.strictEqual(aspectRatio('portrait'), 3 / 4);
    });
    test('auto / fill / unknown are 0 (no strict ratio)', () => {
        assert.strictEqual(aspectRatio('auto'), 0);
        assert.strictEqual(aspectRatio('fill'), 0);
        assert.strictEqual(aspectRatio('whatever'), 0);
    });
});

suite('computePlotDimensions', () => {
    test('fit + auto fills the container and fits', () => {
        const d = computePlotDimensions('fit', 'auto', 1000, 800);
        assert.deepStrictEqual([d.width, d.height], [1000, 800]);
        assert.ok(d.fitsW && d.fitsH);
    });

    test('numeric zoom scales the base-fit size and overflows', () => {
        const d = computePlotDimensions('200', 'auto', 1000, 800);
        assert.deepStrictEqual([d.width, d.height], [2000, 1600]);
        assert.ok(!d.fitsW && !d.fitsH);
    });

    test('50% zoom halves and still fits', () => {
        const d = computePlotDimensions('50', 'auto', 1000, 800);
        assert.deepStrictEqual([d.width, d.height], [500, 400]);
        assert.ok(d.fitsW && d.fitsH);
    });

    test('square aspect in a wide container is height-constrained', () => {
        const d = computePlotDimensions('fit', 'square', 1000, 600);
        assert.deepStrictEqual([d.width, d.height], [600, 600]);
    });

    test('square aspect in a tall container is width-constrained', () => {
        const d = computePlotDimensions('fit', 'square', 400, 1000);
        assert.deepStrictEqual([d.width, d.height], [400, 400]);
    });

    test('landscape 4:3 fit', () => {
        const d = computePlotDimensions('fit', 'landscape', 800, 900);
        // container taller than 4/3 -> width-constrained: 800 x 600
        assert.deepStrictEqual([d.width, d.height], [800, 600]);
    });
});

suite('computeExportCanvas', () => {
    test('default scale is 2x', () => {
        const c = computeExportCanvas(800, 600);
        assert.deepStrictEqual(c, { cw: 1600, ch: 1200, dx: 0, dy: 0, dw: 1600, dh: 1200 });
    });

    test('explicit scale factor', () => {
        const c = computeExportCanvas(800, 600, { scale: 3 });
        assert.strictEqual(c.cw, 2400);
        assert.strictEqual(c.ch, 1800);
        assert.strictEqual(c.dw, 2400);
    });

    test('fixed dimensions letterbox and centre (wider target)', () => {
        // 800x600 into 1920x1080: r = min(2.4, 1.8) = 1.8 -> 1440x1080, centred x
        const c = computeExportCanvas(800, 600, { width: 1920, height: 1080 });
        assert.strictEqual(c.cw, 1920);
        assert.strictEqual(c.ch, 1080);
        assert.strictEqual(c.dw, 1440);
        assert.strictEqual(c.dh, 1080);
        assert.strictEqual(c.dx, 240);
        assert.strictEqual(c.dy, 0);
    });

    test('fixed dimensions letterbox (taller target adds vertical bars)', () => {
        // 800x600 into 1000x1000: r = min(1.25, 1.667) = 1.25 -> 1000x750, centred y
        const c = computeExportCanvas(800, 600, { width: 1000, height: 1000 });
        assert.strictEqual(c.dw, 1000);
        assert.strictEqual(c.dh, 750);
        assert.strictEqual(c.dx, 0);
        assert.strictEqual(c.dy, 125);
    });
});
