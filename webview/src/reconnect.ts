// Reconnect state machine for the webview <-> R WebSocket backends.
//
// Extracted from the webview so the tricky retry/give-up logic is fully typed and
// unit-testable in Node without a DOM or a live socket. The webview keeps ownership
// of the desired/active port sets and the actual connect(); this class only decides
// *when* to retry, with linear backoff and a sticky give-up.

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ReconnectOptions {
    /** Give up after this many consecutive failed attempts (default 8). */
    maxReconnect?: number;
    /** Is this port still a backend we want to be connected to? */
    isDesired: (port: number) => boolean;
    /** Is this port already connected? */
    isActive: (port: number) => boolean;
    /** Perform the actual (re)connection to a port. */
    connect: (port: number) => void;
    log?: (msg: string) => void;
    /** Injectable timers so tests can drive time deterministically. */
    setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
    clearTimeoutFn?: (h: TimerHandle) => void;
}

export class ReconnectManager {
    private timers = new Map<number, TimerHandle>();
    private attempts = new Map<number, number>();
    private readonly max: number;
    private readonly setT: (fn: () => void, ms: number) => TimerHandle;
    private readonly clearT: (h: TimerHandle) => void;

    constructor(private readonly opts: ReconnectOptions) {
        this.max = opts.maxReconnect ?? 8;
        this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
    }

    /** Linear backoff, capped at 5s. Exposed for testing. */
    delay(attempt: number): number {
        return Math.min(1000 * attempt, 5000);
    }

    /** Cancel any pending reconnect for a port and reset its attempt counter. */
    clear(port: number): void {
        port = Number(port);
        const t = this.timers.get(port);
        if (t !== undefined) {
            this.clearT(t);
            this.timers.delete(port);
        }
        this.attempts.delete(port);
    }

    /**
     * Schedule a reconnect to a dropped port unless it is no longer wanted or the
     * attempt budget is exhausted. Sticky give-up: once over budget the counter is
     * kept above it so repeated close events do not restart the cycle; it is reset
     * only by clear() (a successful connect) or a fresh discovery.
     */
    schedule(port: number): void {
        port = Number(port);
        if (this.timers.has(port)) return;          // already scheduled
        if (!this.opts.isDesired(port)) return;     // no longer a live backend
        const n = (this.attempts.get(port) || 0) + 1;
        if (n > this.max) {
            this.opts.log?.(`Giving up reconnect to port ${port}`);
            this.attempts.set(port, n);
            return;
        }
        this.attempts.set(port, n);
        const delay = this.delay(n);
        this.opts.log?.(`Reconnecting to port ${port} in ${delay}ms (attempt ${n}/${this.max})`);
        const t = this.setT(() => {
            this.timers.delete(port);
            if (this.opts.isDesired(port) && !this.opts.isActive(port)) {
                this.opts.connect(port);
            }
        }, delay);
        this.timers.set(port, t);
    }

    // --- inspection helpers (used by tests) ---
    hasTimer(port: number): boolean { return this.timers.has(Number(port)); }
    attemptCount(port: number): number { return this.attempts.get(Number(port)) || 0; }
}
