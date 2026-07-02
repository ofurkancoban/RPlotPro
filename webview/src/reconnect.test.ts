import * as assert from 'assert';
import { ReconnectManager, TimerHandle } from './reconnect';

// A controllable fake timer so tests drive reconnect timing deterministically.
class FakeClock {
    private seq = 0;
    private pending = new Map<number, () => void>();
    setTimeout = (fn: () => void, _ms: number): TimerHandle => {
        const id = ++this.seq;
        this.pending.set(id, fn);
        return id as unknown as TimerHandle;
    };
    clearTimeout = (h: TimerHandle): void => {
        this.pending.delete(h as unknown as number);
    };
    /** Fire every pending timer once (in insertion order). */
    flush(): void {
        const fns = Array.from(this.pending.entries());
        this.pending.clear();
        for (const [, fn] of fns) fn();
    }
    get pendingCount(): number { return this.pending.size; }
}

function make(overrides: Partial<{ desired: Set<number>; active: Set<number>; }> = {}) {
    const desired = overrides.desired ?? new Set<number>([1]);
    const active = overrides.active ?? new Set<number>();
    const clock = new FakeClock();
    const connects: number[] = [];
    const mgr = new ReconnectManager({
        maxReconnect: 8,
        isDesired: (p) => desired.has(p),
        isActive: (p) => active.has(p),
        connect: (p) => { connects.push(p); },
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout
    });
    return { mgr, clock, connects, desired, active };
}

suite('ReconnectManager', () => {
    test('does not schedule for a port that is not desired', () => {
        const { mgr } = make({ desired: new Set() });
        mgr.schedule(1);
        assert.strictEqual(mgr.hasTimer(1), false);
    });

    test('schedules once and connects when the timer fires', () => {
        const { mgr, clock, connects } = make();
        mgr.schedule(1);
        assert.strictEqual(mgr.hasTimer(1), true);
        clock.flush();
        assert.deepStrictEqual(connects, [1]);
    });

    test('a second schedule while one is pending is a no-op', () => {
        const { mgr, clock } = make();
        mgr.schedule(1);
        mgr.schedule(1);
        assert.strictEqual(clock.pendingCount, 1);
    });

    test('linear backoff capped at 5s', () => {
        const { mgr } = make();
        assert.strictEqual(mgr.delay(1), 1000);
        assert.strictEqual(mgr.delay(5), 5000);
        assert.strictEqual(mgr.delay(9), 5000);
    });

    test('sticky give-up after maxReconnect and does not restart', () => {
        const { mgr, clock } = make({ active: new Set() });
        // Each cycle: schedule -> fire (connect fails, still inactive) -> reschedule.
        let fired = 0;
        for (let i = 0; i < 20; i++) {
            mgr.schedule(1);
            if (clock.pendingCount > 0) { fired++; clock.flush(); }
        }
        assert.strictEqual(fired, 8, 'should stop firing after the 8-attempt budget');
        assert.ok(mgr.attemptCount(1) > 8, 'counter stays above budget (sticky)');
        assert.strictEqual(mgr.hasTimer(1), false);
    });

    test('clear() resets the budget so scheduling works again', () => {
        const { mgr, clock } = make();
        for (let i = 0; i < 20; i++) { mgr.schedule(1); if (clock.pendingCount) clock.flush(); }
        assert.ok(mgr.attemptCount(1) > 8);
        mgr.clear(1);
        assert.strictEqual(mgr.attemptCount(1), 0);
        mgr.schedule(1);
        assert.strictEqual(mgr.hasTimer(1), true);
    });

    test('does not connect if the port became active before the timer fires', () => {
        const active = new Set<number>();
        const { mgr, clock, connects } = make({ active });
        mgr.schedule(1);
        active.add(1); // a normal connection succeeded meanwhile
        clock.flush();
        assert.deepStrictEqual(connects, [], 'should skip reconnect when already active');
    });
});
