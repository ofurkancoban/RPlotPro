import * as assert from 'assert';
import { diffPixels } from './diff';

// Helper: build an RGBA buffer from [r,g,b] triples (alpha forced to 255).
function rgba(...px: Array<[number, number, number]>): number[] {
    const out: number[] = [];
    for (const [r, g, b] of px) out.push(r, g, b, 255);
    return out;
}

suite('diffPixels', () => {
    test('identical images report zero changes', () => {
        const a = rgba([10, 20, 30], [40, 50, 60]);
        const r = diffPixels(a, a);
        assert.strictEqual(r.changed, 0);
        assert.strictEqual(r.total, 2);
    });

    test('counts pixels that differ beyond the threshold', () => {
        const a = rgba([0, 0, 0], [100, 100, 100]);
        const b = rgba([0, 0, 0], [200, 100, 100]); // only the 2nd pixel changes (R +100)
        const r = diffPixels(a, b);
        assert.strictEqual(r.changed, 1);
        assert.strictEqual(r.total, 2);
    });

    test('threshold ignores small (anti-aliasing) differences', () => {
        const a = rgba([100, 100, 100]);
        const b = rgba([108, 100, 100]); // R differs by 8
        assert.strictEqual(diffPixels(a, b, { threshold: 0 }).changed, 1);
        assert.strictEqual(diffPixels(a, b, { threshold: 16 }).changed, 0);
    });

    test('changed pixels are painted with the highlight colour, opaque', () => {
        const a = rgba([0, 0, 0]);
        const b = rgba([255, 255, 255]);
        const r = diffPixels(a, b, { highlight: [255, 0, 255] });
        assert.deepStrictEqual([r.out[0], r.out[1], r.out[2], r.out[3]], [255, 0, 255, 255]);
    });

    test('unchanged pixels are faded toward white and stay opaque', () => {
        const a = rgba([0, 0, 0]); // black -> gray 0 -> faded toward white
        const r = diffPixels(a, a, { fade: 0.2 });
        // v = 255 - (255 - 0) * 0.2 = 204
        assert.strictEqual(r.out[0], 204);
        assert.strictEqual(r.out[3], 255);
    });

    test('compares only the overlapping length when sizes differ', () => {
        const a = rgba([0, 0, 0], [0, 0, 0]);
        const b = rgba([255, 0, 0]); // shorter
        const r = diffPixels(a, b);
        assert.strictEqual(r.total, 1);
        assert.strictEqual(r.changed, 1);
    });
});
