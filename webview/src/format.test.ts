import * as assert from 'assert';
import { sniffImageMime } from './format';

suite('sniffImageMime', () => {
    test('uses the declared format when the payload is too small to sniff', () => {
        assert.strictEqual(sniffImageMime('', 'svg', 4), 'image/svg+xml');
        assert.strictEqual(sniffImageMime('', 'png', 4), 'image/png');
        assert.strictEqual(sniffImageMime('', undefined, 0), 'image/png');
    });

    test('leading <svg or <?xml wins over the declared format', () => {
        assert.strictEqual(sniffImageMime('<svg xmlns=...', 'png', 100), 'image/svg+xml');
        assert.strictEqual(sniffImageMime('<?xml version="1.0"?><svg', 'png', 100), 'image/svg+xml');
    });

    test('non-XML bytes are treated as PNG even if declared svg', () => {
        assert.strictEqual(sniffImageMime('\x89PNG\r\n', 'svg', 100), 'image/png');
    });
});
