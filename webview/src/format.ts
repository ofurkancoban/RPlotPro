// Decide the image MIME type for an incoming plot payload. The server's declared
// format is the hint, but the leading bytes win when present (some backends mislabel
// SVG as PNG or vice versa). The webview does the byte decode; this stays pure.

export type ImageMime = 'image/svg+xml' | 'image/png';

export function sniffImageMime(headText: string, metadataFormat?: string, byteLength = 0): ImageMime {
    let mime: ImageMime = metadataFormat === 'svg' ? 'image/svg+xml' : 'image/png';
    if (byteLength > 10) {
        mime = (headText.includes('<svg') || headText.includes('<?xml')) ? 'image/svg+xml' : 'image/png';
    }
    return mime;
}
