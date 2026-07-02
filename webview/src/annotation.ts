// Pure annotation geometry: pointer-to-canvas coordinate mapping and arrow-head
// vertices. The canvas drawing stays in the webview; only the math lives here so
// it is typed and unit-testable without a DOM.

export interface RectLike {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

// Map a pointer position (client coords) to the annotation canvas' internal pixel
// coordinates, accounting for the canvas being displayed at a different CSS size.
export function toCanvasCoords(
    clientX: number,
    clientY: number,
    rect: RectLike,
    canvasW: number,
    canvasH: number
): Point {
    return {
        x: (clientX - rect.left) * (canvasW / rect.width),
        y: (clientY - rect.top) * (canvasH / rect.height)
    };
}

export interface ArrowGeometry {
    angle: number;
    // where the shaft stops (just short of the tip so the head defines the point)
    lineEndX: number;
    lineEndY: number;
    // the three arrow-head vertices
    tipX: number;
    tipY: number;
    leftX: number;
    leftY: number;
    rightX: number;
    rightY: number;
}

// Compute the shaft end and the arrow-head triangle for an arrow from -> to.
export function arrowGeometry(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    headLength = 20,
    tipInset = 5
): ArrowGeometry {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headAngle = Math.PI / 6; // 30 degrees each side -> 60 degree tip
    return {
        angle,
        lineEndX: toX - tipInset * Math.cos(angle),
        lineEndY: toY - tipInset * Math.sin(angle),
        tipX: toX,
        tipY: toY,
        leftX: toX - headLength * Math.cos(angle - headAngle),
        leftY: toY - headLength * Math.sin(angle - headAngle),
        rightX: toX - headLength * Math.cos(angle + headAngle),
        rightY: toY - headLength * Math.sin(angle + headAngle)
    };
}
