import * as assert from 'assert';
import { aspectRatio, computePlotDimensions, computeExportCanvas, paletteScale, computeSplitCanvas } from './geometry';

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

suite('paletteScale', () => {
    test('full size in a large container', () => {
        assert.strictEqual(paletteScale(800, 600), 1.0);
    });
    test('scales down in a small container, floored at 0.6', () => {
        assert.strictEqual(paletteScale(300, 300), 0.6);          // min(0.6,0.6) -> 0.6
        assert.strictEqual(paletteScale(350, 399), 350 / 500);    // 0.7, above the floor
    });
});

suite('computeSplitCanvas', () => {
    test('equal plots sit side by side, full height', () => {
        const s = computeSplitCanvas(800, 600, 800, 600, 2);
        assert.strictEqual(s.canvasW, 3200); // (800+800)*2
        assert.strictEqual(s.canvasH, 1200); // 600*2
        assert.deepStrictEqual(s.left, { x: 0, y: 0, w: 1600, h: 1200 });
        assert.deepStrictEqual(s.right, { x: 1600, y: 0, w: 1600, h: 1200 });
    });

    test('shorter plot is vertically centred against the taller one', () => {
        const s = computeSplitCanvas(800, 300, 800, 600, 1);
        assert.strictEqual(s.canvasH, 600);
        assert.strictEqual(s.left.h, 300);
        assert.strictEqual(s.left.y, 150); // (600-300)/2
        assert.strictEqual(s.right.y, 0);
    });

    test('falls back to 800x600 for missing natural sizes', () => {
        const s = computeSplitCanvas(0, 0, 0, 0, 1);
        assert.strictEqual(s.canvasW, 1600);
        assert.strictEqual(s.canvasH, 600);
    });
});
