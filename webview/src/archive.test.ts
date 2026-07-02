import * as assert from 'assert';
import { mergePlotLists, idNum } from './archive';

suite('mergePlotLists', () => {
    test('idNum strips the language prefix for chronological sort', () => {
        assert.strictEqual(idNum('r-1000'), 1000);
        assert.strictEqual(idNum('jl-42'), 42);
        assert.strictEqual(idNum('nonsense'), 0);
    });

    test('tags incoming plots with the port and sorts by id', () => {
        const out = mergePlotLists([], [{ id: 'r-2' }, { id: 'r-1' }], 8000);
        assert.deepStrictEqual(out.map(p => p.id), ['r-1', 'r-2']);
        assert.ok(out.every(p => p.port === 8000));
    });

    test('keeps plots from other live ports (multi-terminal)', () => {
        const existing = [{ id: 'jl-5', port: 9000 }];
        const out = mergePlotLists(existing, [{ id: 'r-1' }], 8000);
        assert.deepStrictEqual(out.map(p => p.id).sort(), ['jl-5', 'r-1']);
    });

    test('replaces only plots from the same port', () => {
        const existing = [{ id: 'r-1', port: 8000, note: 'stale' }];
        const out = mergePlotLists(existing, [{ id: 'r-1', note: 'fresh' }], 8000);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].note, 'fresh');
        assert.strictEqual(out[0].port, 8000);
    });

    test('archived plots survive when a different/empty port list arrives', () => {
        const existing = [{ id: 'r-1', port: 'archive' }];
        const out = mergePlotLists(existing, [], 8000);
        assert.deepStrictEqual(out.map(p => p.id), ['r-1']);
        assert.strictEqual(out[0].port, 'archive');
    });

    test('a live plot supersedes its archived copy of the same id', () => {
        const existing = [{ id: 'r-1', port: 'archive', note: 'archived' }];
        const out = mergePlotLists(existing, [{ id: 'r-1', note: 'live' }], 8000);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].port, 8000);
        assert.strictEqual(out[0].note, 'live');
    });

    test('archive is kept alongside a live plot with a different id', () => {
        const existing = [{ id: 'r-1', port: 'archive' }];
        const out = mergePlotLists(existing, [{ id: 'r-2' }], 8000);
        assert.deepStrictEqual(out.map(p => p.id), ['r-1', 'r-2']);
    });
});
