// Per-plot annotation undo/redo history. Pure stack management (bounded), extracted
// from the webview so it is typed and unit-testable without a canvas. The webview
// supplies the canvas snapshots (data URLs) and does the actual rendering.

interface Stacks {
    undo: string[];
    redo: string[];
}

export class AnnotationHistory {
    private readonly map = new Map<string, Stacks>();

    constructor(private readonly limit = 30) {}

    private get(pid: string | number): Stacks {
        const key = String(pid);
        let s = this.map.get(key);
        if (!s) {
            s = { undo: [], redo: [] };
            this.map.set(key, s);
        }
        return s;
    }

    canUndo(pid: string | number): boolean {
        return this.get(pid).undo.length > 0;
    }

    canRedo(pid: string | number): boolean {
        return this.get(pid).redo.length > 0;
    }

    // Record a new committed state: push the previous snapshot onto the undo stack
    // (bounded by `limit`) and clear the redo stack (a new action forks history).
    commit(pid: string | number, previousState: string): void {
        const s = this.get(pid);
        s.undo.push(previousState);
        if (s.undo.length > this.limit) s.undo.shift();
        s.redo = [];
    }

    // Undo: caller passes the current snapshot (pushed to redo). Returns the snapshot
    // to render, or null if there is nothing to undo.
    undo(pid: string | number, currentState: string): string | null {
        const s = this.get(pid);
        if (s.undo.length === 0) return null;
        s.redo.push(currentState);
        return s.undo.pop() ?? null;
    }

    // Redo: mirror of undo.
    redo(pid: string | number, currentState: string): string | null {
        const s = this.get(pid);
        if (s.redo.length === 0) return null;
        s.undo.push(currentState);
        return s.redo.pop() ?? null;
    }

    clear(pid?: string | number): void {
        if (pid === undefined) this.map.clear();
        else this.map.delete(String(pid));
    }
}
