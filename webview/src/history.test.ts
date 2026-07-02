import * as assert from 'assert';
import { AnnotationHistory } from './history';

suite('AnnotationHistory', () => {
    test('empty history cannot undo or redo', () => {
        const h = new AnnotationHistory();
        assert.strictEqual(h.canUndo('p'), false);
        assert.strictEqual(h.canRedo('p'), false);
        assert.strictEqual(h.undo('p', 'cur'), null);
        assert.strictEqual(h.redo('p', 'cur'), null);
    });

    test('commit enables undo and clears redo', () => {
        const h = new AnnotationHistory();
        h.commit('p', 'A');
        assert.strictEqual(h.canUndo('p'), true);
        assert.strictEqual(h.canRedo('p'), false);
    });

    test('undo returns the previous state and enables redo', () => {
        const h = new AnnotationHistory();
        h.commit('p', 'A');            // undo:[A]
        const prev = h.undo('p', 'B'); // render A, redo:[B]
        assert.strictEqual(prev, 'A');
        assert.strictEqual(h.canRedo('p'), true);
        assert.strictEqual(h.canUndo('p'), false);
    });

    test('redo mirrors undo', () => {
        const h = new AnnotationHistory();
        h.commit('p', 'A');
        h.undo('p', 'B');              // redo:[B]
        const next = h.redo('p', 'A'); // render B, undo:[A]
        assert.strictEqual(next, 'B');
        assert.strictEqual(h.canUndo('p'), true);
        assert.strictEqual(h.canRedo('p'), false);
    });

    test('a fresh commit forks history (clears redo)', () => {
        const h = new AnnotationHistory();
        h.commit('p', 'A');
        h.undo('p', 'B');   // redo:[B]
        h.commit('p', 'C'); // new action -> redo cleared
        assert.strictEqual(h.canRedo('p'), false);
    });

    test('undo stack is bounded by the limit (oldest dropped)', () => {
        const h = new AnnotationHistory(3);
        for (const s of ['A', 'B', 'C', 'D', 'E']) h.commit('p', s);
        // only the last 3 remain; undo pops D..B, then empty (A/B... A dropped)
        assert.strictEqual(h.undo('p', 'x'), 'E');
        assert.strictEqual(h.undo('p', 'x'), 'D');
        assert.strictEqual(h.undo('p', 'x'), 'C');
        assert.strictEqual(h.undo('p', 'x'), null);
    });

    test('history is isolated per plot id', () => {
        const h = new AnnotationHistory();
        h.commit('p1', 'A');
        assert.strictEqual(h.canUndo('p1'), true);
        assert.strictEqual(h.canUndo('p2'), false);
    });

    test('clear removes one plot or all', () => {
        const h = new AnnotationHistory();
        h.commit('p1', 'A');
        h.commit('p2', 'B');
        h.clear('p1');
        assert.strictEqual(h.canUndo('p1'), false);
        assert.strictEqual(h.canUndo('p2'), true);
        h.clear();
        assert.strictEqual(h.canUndo('p2'), false);
    });
});
