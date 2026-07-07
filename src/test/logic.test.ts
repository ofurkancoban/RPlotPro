import * as assert from 'assert';
import {
    detectLaunchLanguage,
    contentHasHook,
    addHookToContent,
    removeHookFromContent,
    R_HOOK_BODY
} from '../extension';

suite('detectLaunchLanguage', () => {
    const R_CASES = ['R', '/usr/bin/R', 'R --no-save --quiet', '"/opt/homebrew/bin/R"', 'Rterm', 'radian', 'RADIAN'];
    const JL_CASES = ['julia', '/opt/julia-1.10/bin/julia', 'julia --project=.', 'julia.exe', 'C:\\\\Julia\\\\julia.exe'];
    const NONE_CASES = ['', '   ', 'rm -rf /tmp/x', 'rsync -a a b', 'ruby app.rb', 'rustc main.rs', 'Rscript batch.R', 'python plot.py', 'ls -la', 'read x'];

    R_CASES.forEach(cmd => test(`R: "${cmd}"`, () => assert.strictEqual(detectLaunchLanguage(cmd), 'r')));
    JL_CASES.forEach(cmd => test(`Julia: "${cmd}"`, () => assert.strictEqual(detectLaunchLanguage(cmd), 'julia')));
    NONE_CASES.forEach(cmd => test(`none: "${cmd}"`, () => assert.strictEqual(detectLaunchLanguage(cmd), null)));
});

suite('startup-hook content helpers', () => {
    // Exercise the production hook body, not a local copy, so changes to the
    // real string (like the interactive() guard) stay covered by these tests.
    const BODY = R_HOOK_BODY;

    test('production R hook only runs in interactive sessions', () => {
        assert.ok(BODY.includes('if(interactive())'));
    });

    test('adds a hook to empty content', () => {
        const out = addHookToContent('', BODY);
        assert.ok(contentHasHook(out));
        assert.ok(out.includes(BODY));
        assert.ok(out.includes('# [R Plot Pro END]'));
    });

    test('preserves existing content and inserts a separating newline', () => {
        const out = addHookToContent('options(stringsAsFactors = FALSE)', BODY);
        assert.ok(out.startsWith('options(stringsAsFactors = FALSE)'));
        assert.ok(contentHasHook(out));
    });

    test('is idempotent (does not add a second hook)', () => {
        const once = addHookToContent('x <- 1\n', BODY);
        const twice = addHookToContent(once, BODY);
        assert.strictEqual(once, twice);
        assert.strictEqual(once.match(/# \[R Plot Pro\]/g)?.length, 1);
    });

    test('removeHookFromContent removes the block and reports removed', () => {
        const withHook = addHookToContent('x <- 1\n', BODY);
        const res = removeHookFromContent(withHook);
        assert.strictEqual(res.removed, true);
        assert.strictEqual(contentHasHook(res.content), false);
        assert.ok(res.content.includes('x <- 1'));
    });

    test('removeHookFromContent is a no-op when absent', () => {
        const res = removeHookFromContent('y <- 2\n');
        assert.strictEqual(res.removed, false);
        assert.strictEqual(res.content, 'y <- 2\n');
    });

    test('add then remove round-trips back to clean content', () => {
        const original = 'setwd("~/proj")\noptions(digits = 4)\n';
        const added = addHookToContent(original, BODY);
        const removed = removeHookFromContent(added).content;
        assert.strictEqual(contentHasHook(removed), false);
        assert.ok(removed.includes('setwd("~/proj")'));
        assert.ok(removed.includes('options(digits = 4)'));
    });
});
