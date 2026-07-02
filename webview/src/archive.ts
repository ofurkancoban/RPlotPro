// Gallery merge logic, extracted from the webview so it can be unit-tested.
//
// When the R server sends its authoritative plot list for a given port, we must
// merge it with what the webview already holds: keep plots from *other* live ports
// (multi-terminal), keep archived plots (so history survives an R restart), and let
// a live plot supersede its archived copy of the same id. Result is sorted by the
// numeric part of the id (chronological).

export interface PlotLike {
    id: string | number;
    port?: number | string;
    [key: string]: unknown;
}

// IDs look like "r-<timestamp>" / "jl-<timestamp>"; strip the prefix so sorting is
// chronological rather than alphabetic.
export function idNum(id: string | number): number {
    return Number(String(id).replace(/^[a-z]+-/i, '')) || 0;
}

/**
 * Merge the server's plot list for `port` into the existing set.
 * - Plots from other live ports are preserved.
 * - Archived plots (port === 'archive') are preserved unless a live plot with the
 *   same id arrives, in which case the live one wins.
 * - Incoming plots are tagged with `port`.
 */
export function mergePlotLists(existing: PlotLike[], incoming: PlotLike[], port: number): PlotLike[] {
    const otherPlots = existing.filter(p => p.port && p.port !== port);
    const taggedIncoming = incoming.map(np => ({ ...np, port }));

    const byId = new Map<string, PlotLike>();
    for (const p of [...otherPlots, ...taggedIncoming]) {
        const key = String(p.id);
        const prev = byId.get(key);
        if (!prev || (prev.port === 'archive' && p.port !== 'archive')) {
            byId.set(key, p);
        }
    }
    return Array.from(byId.values()).sort((a, b) => idNum(a.id) - idNum(b.id));
}
