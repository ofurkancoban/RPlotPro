import * as assert from 'assert';
import { toCanvasCoords, arrowGeometry } from './annotation';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

suite('toCanvasCoords', () => {
    test('1:1 canvas maps client to the same offset', () => {
        const p = toCanvasCoords(50, 50, { left: 0, top: 0, width: 100, height: 100 }, 100, 100);
        assert.deepStrictEqual(p, { x: 50, y: 50 });
    });

    test('scales when the canvas is displayed larger and offset', () => {
        // rect offset (10,20), displayed 100x50, internal 400x200
        const p = toCanvasCoords(60, 45, { left: 10, top: 20, width: 100, height: 50 }, 400, 200);
        assert.deepStrictEqual(p, { x: 200, y: 100 });
    });
});

suite('arrowGeometry', () => {
    test('horizontal arrow: symmetric head, shaft stops short of tip', () => {
        const g = arrowGeometry(0, 0, 10, 0);
        near(g.angle, 0);
        near(g.lineEndX, 5);   // 10 - tipInset(5)*cos0
        near(g.lineEndY, 0);
        assert.deepStrictEqual([g.tipX, g.tipY], [10, 0]);
        // head vertices symmetric about the x axis
        near(g.leftY, 10);
        near(g.rightY, -10);
        near(g.leftX, g.rightX);
    });

    test('honours custom head length', () => {
        const g = arrowGeometry(0, 0, 0, 10, 40); // pointing down, angle = pi/2
        near(g.angle, Math.PI / 2);
        near(g.tipX, 0);
        near(g.tipY, 10);
        // head reaches back ~40 along the shaft
        near(g.leftX, -40 * Math.cos(Math.PI / 2 - Math.PI / 6));
    });
});
