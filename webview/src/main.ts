import * as RPlotCore from './index';
// Provided by the VS Code webview host at runtime.
declare const acquireVsCodeApi: any;

// Gradual-typing seam for this ported webview script. getElementById() returns the
// generic HTMLElement, but the code knows the concrete subtype (img/input/canvas) at
// each call, and a few expando flags are stashed on DOM nodes. Rather than cast every
// site, the accessed members are declared as optional here so the file type-checks at
// the lenient bar (which still catches undeclared identifiers, wrong arg counts, etc.).
// Tighten this module by module: replace a group of these with real casts, then delete
// the corresponding lines below.
declare global {
    interface WebSocket { _intentionalClose?: boolean; }
    interface EventTarget { tagName?: any; isContentEditable?: any; value?: any; closest?: any; }
    interface Element { style?: any; src?: any; value?: any; }
    interface HTMLElement {
        src?: any; value?: any; disabled?: any; getContext?: any;
        naturalWidth?: any; naturalHeight?: any; width?: any; height?: any;
        pendingSource?: any; hasPanListener?: any; hasDragListener?: any; hasListener?: any;
        hasInspectListener?: any;
    }
}

const vscode = acquireVsCodeApi();
let plots = [];
const state = vscode.getState() || {};
let currentIndex = typeof state.currentIndex === 'number' ? state.currentIndex : -1;
let ws = null;
let reconnectTimer = null;
let currentPort = 0;
let resizeTimeout;
let showOnlyFavorites = false;
let currentNoteIndex = -1;
let plotUrls = new Map(); // Store Object URLs by plot ID
// Per-plot favorites/notes restored from workspace storage (id -> {note, isFavorite}).
// Applied when the server's plot_list arrives so metadata survives restarts.
let savedMetaMap = new Map();

// Rebuild the metadata map from what the extension restored, then apply it to any
// plots already loaded so favorites/notes reappear without waiting for a new plot_list.
function applyRestoredMeta(meta) {
    savedMetaMap = new Map((meta || []).map(m => [m.id, { note: m.note || '', isFavorite: !!m.isFavorite }]));
    plots.forEach(p => {
        const m = savedMetaMap.get(p.id);
        if (m) { p.note = m.note; p.isFavorite = m.isFavorite; }
    });
    updatePlotList();
}

// Send compact per-plot metadata to the extension for durable workspace storage.
function persistMeta() {
    const meta = plots.map(p => ({ id: p.id, note: p.note || '', isFavorite: !!p.isFavorite }));
    savedMetaMap = new Map(meta.map(m => [m.id, { note: m.note, isFavorite: m.isFavorite }]));
    vscode.postMessage({ command: 'persist_meta', meta });
}

// --- GALLERY ARCHIVE (survives R shutdown / VS Code restart) ---
const ARCHIVE_MAX = 60;   // cap archived plots to bound disk usage
let archiveTimer = null;

function dataURLToBlob(dataURL) {
    const [head, b64] = String(dataURL).split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64 || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

async function blobUrlToDataURL(url) {
    try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return await new Promise((res) => {
            const r = new FileReader();
            r.onloadend = () => res(r.result);
            r.onerror = () => res(null);
            r.readAsDataURL(blob);
        });
    } catch (_) { return null; }
}

// Debounced snapshot of the current gallery (image bytes + metadata) to disk,
// so plots remain browsable after the R server is gone. Only plots whose bytes
// we already have are archived; the rest are archived once their binary loads.
function persistArchive() {
    if (archiveTimer) clearTimeout(archiveTimer);
    archiveTimer = setTimeout(async () => {
        archiveTimer = null;
        try {
            const recent = plots.slice(-ARCHIVE_MAX);
            const out = [];
            for (const p of recent) {
                let data = null;
                const url = plotUrls.get(p.id);
                if (url) data = await blobUrlToDataURL(url);
                else if (p.data && String(p.data).startsWith('data:')) data = p.data;
                if (!data) continue;
                out.push({
                    id: p.id,
                    data,
                    format: p.format || 'png',
                    timestamp: p.timestamp || '',
                    note: p.note || '',
                    isFavorite: !!p.isFavorite,
                    code: p.code || '',
                    srcFile: p.srcFile || '',
                    srcLine1: p.srcLine1,
                    srcLine2: p.srcLine2
                });
            }
            vscode.postMessage({ command: 'persist_archive', plots: out });
        } catch (e) {
            log('persistArchive failed: ' + e);
        }
    }, 1500);
}

// Load archived plots that are not currently present (a live plot always wins).
function applyRestoredArchive(archived) {
    if (!archived || !archived.length) return;
    let added = false;
    for (const a of archived) {
        if (!a || !a.id || !a.data) continue;
        if (plots.some(p => String(p.id) === String(a.id))) continue;
        try {
            const url = URL.createObjectURL(dataURLToBlob(a.data));
            plotUrls.set(a.id, url);
            const meta = savedMetaMap.get(a.id);
            plots.push({
                id: a.id,
                data: url,
                format: a.format || 'png',
                timestamp: a.timestamp || '',
                note: (meta ? meta.note : a.note) || '',
                isFavorite: meta ? meta.isFavorite : !!a.isFavorite,
                code: a.code || '',
                srcFile: a.srcFile || '',
                srcLine1: a.srcLine1,
                srcLine2: a.srcLine2,
                port: 'archive'
            });
            added = true;
        } catch (e) {
            log('restore archive item failed: ' + e);
        }
    }
    if (added) {
        const idNum = id => Number(String(id).replace(/^[a-z]+-/i, '')) || 0;
        plots.sort((x, y) => idNum(x.id) - idNum(y.id));
        if (currentIndex < 0 && plots.length) currentIndex = plots.length - 1;
        updatePlotList();
        if (currentIndex >= 0) showPlot(currentIndex, false);
    }
}
let thumbObserver; // For lazy loading
let isSplitMode = false;
let leftIndex = typeof state.leftIndex === 'number' ? state.leftIndex : -1;
let rightIndex = typeof state.rightIndex === 'number' ? state.rightIndex : -1;
let isDraggingDivider = false;
// Dark (inverted) plot mode. By default it follows the VS Code color theme; a manual
// toggle pins it for the session. VS Code tags the webview body with vscode-dark /
// vscode-light / vscode-high-contrast.
function detectVsCodeDark() {
    const c = document.body.classList;
    return c.contains('vscode-dark') || c.contains('vscode-high-contrast');
}
let darkModeUserSet = typeof state.darkMode === 'boolean';
let isDarkMode = darkModeUserSet ? state.darkMode : detectVsCodeDark();

// User setting (persisted): show data coordinates when hovering a static plot.
let hoverInspectEnabled = state.hoverInspect !== false;
let lastCanvasData = new Map(); // Store base64 canvas data per plot ID
// Per-plot zoom level (plotId -> zoom class name e.g. 'fit','100'). Remembered so each
// plot keeps its own zoom instead of a single global one.
let plotZoom = state.plotZoom ? new Map(Object.entries(state.plotZoom)) : new Map();

// Annotation State
let isAnnotating = false;
let currentTool = 'pencil';
let currentColor = '#ff4757';
let isDrawing = false;
let activeCanvas = null;
let activeCtx = null;
let activePane = 'left';
let paletteState = state.palette || { x: 40, y: 40, isHorizontal: true };
// Per-plot annotation undo/redo, managed by the typed, unit-tested core.
const annotationHistory = new RPlotCore.AnnotationHistory(30);

// Rehydrate annotations if available
if (state.annotations) {
    for (const [id, data] of Object.entries(state.annotations)) {
        lastCanvasData.set(String(id), data);
    }
}

function log(msg) {
    console.log('[R Plot]', msg);
    logToUI(msg);
    // Mirror debug lines to the extension's Output channel for diagnostics.
    try { vscode.postMessage({ command: 'log', text: String(msg) }); } catch (_) {}
}

// --- SCALING & DIMENSIONS (New JS-driven approach) ---

function getZoomFromClass(target) {
    const zoomLevels = ['fit', '50', '75', '100', '200'];
    for (const z of zoomLevels) {
        if (target.classList.contains('zoom-' + z)) return z;
    }
    return 'fit';
}

function getScaleFromClass(target) {
    const aspectRatios = ['auto', 'square', 'landscape', 'portrait', 'fill'];
    for (const a of aspectRatios) {
        if (target.classList.contains('aspect-' + a)) return a;
    }
    return 'auto';
}

function updatePlotDimensions(wrapperId) {
    const previewWrappers = ['mainMediaWrapper', 'leftMediaWrapper', 'rightMediaWrapper'];
    if (!previewWrappers.includes(wrapperId)) return;
    
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper) return;
    const container = wrapper.parentElement;
    if (!container) return; // container is plot-container or split-pane

    const zoom = getZoomFromClass(wrapper);
    const aspect = getScaleFromClass(wrapper);
    
    // Container dimensions (available space)
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    
    if (cw === 0 || ch === 0) return; // Not visible yet

    // Sizing math lives in the typed, unit-tested core.
    const dims = RPlotCore.computePlotDimensions(zoom, aspect, cw, ch);
    const targetW = dims.width;
    const targetH = dims.height;

    wrapper.style.width = Math.floor(targetW) + 'px';
    wrapper.style.height = Math.floor(targetH) + 'px';

    // 4. Centering Strategy (v0.0.49 Smart Centering)
    const fitsW = dims.fitsW;
    const fitsH = dims.fitsH;

    // Set margins based on whether it fits
    wrapper.style.marginLeft = fitsW ? 'auto' : '0';
    wrapper.style.marginRight = fitsW ? 'auto' : '0';
    wrapper.style.marginTop = fitsH ? 'auto' : '0';
    wrapper.style.marginBottom = fitsH ? 'auto' : '0';

    if (fitsW && fitsH) {
        // Fits perfectly: No scroll centering needed
        container.scrollLeft = 0;
        container.scrollTop = 0;
        wrapper.style.visibility = 'visible';
    } else {
        // Overflows: Handle scroll centering
        wrapper.style.visibility = 'hidden';
        
        let attempts = 0;
        const doCenter = () => {
            // Force redraw/reflow for accurate scrollWidth
            const _reflow = container.offsetHeight;
            const sw = container.scrollWidth;
            const sh = container.scrollHeight;
            const cw_actual = container.clientWidth;
            const ch_actual = container.clientHeight;
            
            if (sw > cw_actual) container.scrollLeft = (sw - cw_actual) / 2;
            if (sh > ch_actual) container.scrollTop = (sh - ch_actual) / 2;
            
            attempts++;
            if (attempts < 15) {
                requestAnimationFrame(doCenter);
            } else {
                wrapper.style.visibility = 'visible';
                // Final cleanup frame after CSS transition (0.3s)
                setTimeout(() => {
                    if (sw > cw_actual) container.scrollLeft = (sw - cw_actual) / 2;
                    if (sh > ch_actual) container.scrollTop = (sh - ch_actual) / 2;
                }, 350);
            }
        };
        requestAnimationFrame(doCenter);
    }
    
    if (isAnnotating && activeCanvas && activeCanvas.parentElement === wrapper) {
        setupActiveCanvas();
        updatePaletteScaling();
        const pid = isSplitMode ? 
            (wrapperId === 'leftMediaWrapper' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
            plots[currentIndex]?.id;
        if (pid) restoreAnnotation(pid, activeCanvas.id);
    }
}

function logToUI(msg) {
    const debugLog = document.getElementById('debugLog');
    if (debugLog) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        debugLog.prepend(entry);
        if (debugLog.childNodes.length > 50) debugLog.removeChild(debugLog.lastChild);
    }
}

// Initialized at end of script

window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'set_ports':
            updateConnections(message.backends);
            break;
        case 'set_active_file':
            // Broadcast to all active backends
            broadcastToBackends({ 
                type: 'set_active_file', 
                filePath: message.filePath 
            });
            break;
        case 'store_active_file':
            // Store in state for WebSocket reconnection
            const currentState = vscode.getState() || {};
            vscode.setState({ ...currentState, activeFile: message.filePath });
            break;
        case 'next_plot': nextPlot(); break;
        case 'previous_plot': previousPlot(); break;
        case 'clear_plots': clearAllPlots(); break;
        case 'export_plot': exportPlot(); break;
        case 'do_export': exportAsFormat(message.format, message); break;
        case 'highlight_source': highlightPlotsForSource(message.file, message.line); break;
        case 'toggle_annotation': toggleAnnotationMode(); break;
        case 'restore_meta': applyRestoredMeta(message.meta); break;
        case 'restore_archive': applyRestoredArchive(message.plots); break;
        case 'info': console.info(message.text); break;
    }
});

// Optimized Debounce (150ms)
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => { clearTimeout(timeout); func(...args); };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const activeSockets = new Map(); // port -> WebSocket
const portLanguages = new Map(); // port -> language
const desiredPorts = new Map();      // port -> language: ports we want to stay connected to
const portUrls = new Map();          // port -> ws URL resolved by the extension (Remote-SSH/WSL/Codespaces forwarding)

// Reconnect state machine lives in the typed, unit-tested core module. main.ts keeps
// ownership of desiredPorts/activeSockets and the actual connect(); it only decides when.
const reconnectMgr = new RPlotCore.ReconnectManager({
    maxReconnect: 8,
    isDesired: (port) => desiredPorts.has(Number(port)),
    isActive: (port) => activeSockets.has(Number(port)),
    connect: (port) => connectToPort(Number(port), desiredPorts.get(Number(port))),
    log: (msg) => log(msg)
});

function clearReconnect(port) { reconnectMgr.clear(Number(port)); }
function scheduleReconnect(port) { reconnectMgr.schedule(Number(port)); }

const LOGOS = {
    julia: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M58.3 93.5c0 15.7-12.7 28.3-28.3 28.3-15.7 0-28.3-12.7-28.3-28.3 0-15.6 12.7-28.3 28.3-28.3 15.6-.1 28.3 12.6 28.3 28.3" fill="#cb3c33"/><path d="M30 123.4c-16.5 0-30-13.4-30-30s13.4-30 30-30 30 13.4 30 30-13.5 30-30 30zm0-56.6c-14.7 0-26.7 12-26.7 26.7s12 26.7 26.7 26.7 26.7-12 26.7-26.7-12-26.7-26.7-26.7z" fill="#eee"/><path d="M126.4 93.5c0 15.7-12.7 28.3-28.3 28.3s-28.3-12.7-28.3-28.3c0-15.6 12.7-28.3 28.3-28.3s28.3 12.6 28.3 28.3" fill="#9558b2"/><path d="M98 123.4c-16.5 0-30-13.4-30-30s13.4-30 30-30 30 13.4 30 30-13.4 30-30 30zm0-56.6c-14.7 0-26.7 12-26.7 26.7s12 26.7 26.7 26.7 26.7-12 26.7-26.7S112.8 66.8 98 66.8z" fill="#eee"/><path d="M92.4 34.5c0 15.6-12.7 28.3-28.3 28.3-15.7 0-28.3-12.7-28.3-28.3S48.4 6.2 64 6.2c15.7 0 28.4 12.7 28.4 28.3" fill="#389826"/><path d="M64 64.5c-16.5 0-30-13.4-30-30s13.4-30 30-30 30 13.4 30 30-13.5 30-30 30zm0-56.7c-14.7 0-26.7 12-26.7 26.7s12 26.7 26.7 26.7 26.7-12 26.7-26.7S78.7 7.8 64 7.8z" fill="#eee"/></svg>`,
    r: `<svg preserveAspectRatio="xMidYMid" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><path d="M64 100.38c-35.346 0-64-19.19-64-42.863 0-23.672 28.654-42.863 64-42.863s64 19.19 64 42.863c0 23.672-28.654 42.863-64 42.863zm9.796-68.967c-26.866 0-48.646 13.119-48.646 29.303 0 16.183 21.78 29.303 48.646 29.303s46.693-8.97 46.693-29.303c0-20.327-19.827-29.303-46.693-29.303z" fill="#a0a1a5" fill-rule="evenodd"/><path d="M97.469 81.033s3.874 1.169 6.124 2.308c.78.395 2.132 1.183 3.106 2.219a8.388 8.388 0 011.42 2.04l15.266 25.74-24.674.01-11.537-21.666s-2.363-4.06-3.817-5.237c-1.213-.982-1.73-1.331-2.929-1.331h-5.862l.004 28.219-21.833.009V41.26h43.844s19.97.36 19.97 19.359c0 18.999-19.082 20.413-19.082 20.413zm-9.497-24.137l-13.218-.009-.006 12.258 13.224-.005s6.124-.019 6.124-6.235c0-6.34-6.124-6.009-6.124-6.009z" fill="#1f65b7" fill-rule="evenodd"/></svg>`
};

function updateConnections(backends) {
    if (!backends) return;
    
    const ports = backends.map(b => Number(b.port));

    // Remember which ports we want to stay connected to, so an unexpected drop can
    // be told apart from a backend that genuinely went away (auto-reconnect).
    desiredPorts.clear();
    for (const b of backends) {
        desiredPorts.set(Number(b.port), b.language);
        // Remember the forwarded URL the extension resolved for this port, if any.
        if (b.wsUrl) portUrls.set(Number(b.port), b.wsUrl);
    }

    // 1. Close connections for ports no longer in the list
    for (const [port, socket] of activeSockets) {
        if (!ports.includes(Number(port))) {
            log(`Closing connection to port ${port}`);
            socket._intentionalClose = true;   // do not auto-reconnect this one
            clearReconnect(port);
            socket.close();
            activeSockets.delete(port);
            portLanguages.delete(port);
            portUrls.delete(port);
        }
    }
    
    // 2. Open connections for new ports
    for (const backend of backends) {
        const port = Number(backend.port);
        const lang = backend.language;
        
        if (!activeSockets.has(port)) {
            connectToPort(port, lang);
        } else if (lang && !portLanguages.has(port)) {
            // Update language if it was missing initially
            portLanguages.set(port, lang);
            updateConnectionStatus(true);
        }
    }
    
    updateConnectionStatus(activeSockets.size > 0);
}

function broadcastToBackends(data, targetPort = null) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    
    // Targeted routing if port is known
    if (targetPort && activeSockets.has(Number(targetPort))) {
        const socket = activeSockets.get(Number(targetPort));
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(msg);
            return;
        }
    }
    
    // Fallback: Broadcast to all active backends
    for (const socket of activeSockets.values()) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(msg);
        }
    }
}

function connectToPort(port, language) {
    // Prefer the URL the extension resolved via asExternalUri (handles Remote-SSH,
    // WSL, Dev Containers and Codespaces port forwarding); fall back to loopback.
    const url = portUrls.get(Number(port)) || ('ws://127.0.0.1:' + port);
    log(`Connecting to ${url}...`);
    
    try {
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        let heartbeat;
        let p = port;
        let lang = language;

        socket.onopen = () => {
            log(`Connected to port ${p}`);
            clearReconnect(p);   // reset backoff on a successful connection
            activeSockets.set(p, socket);
            if (lang) portLanguages.set(p, lang);
            updateConnectionStatus(true);
            socket.send(JSON.stringify({ type: 'get_plots' }));
            
            // Heartbeat
            heartbeat = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);

            const activeFile = (vscode.getState() || {}).activeFile;
            if (activeFile) {
                socket.send(JSON.stringify({ 
                    type: 'set_active_file', 
                    filePath: activeFile 
                }));
            }
            
            setTimeout(() => { refreshLayout(); sendResizeEvent(); }, 150);
        };

        socket.onclose = () => {
            if (heartbeat) clearInterval(heartbeat);
            activeSockets.delete(p);
            portLanguages.delete(p);
            updateConnectionStatus(activeSockets.size > 0);
            log(`Closed port ${p}`);
            // Auto-reconnect on an unexpected drop (R busy, transient network) so the
            // view recovers on its own instead of staying "Offline" until R restarts.
            if (!socket._intentionalClose) scheduleReconnect(p);
        };

        socket.onerror = (e) => {
            if (heartbeat) clearInterval(heartbeat);
            activeSockets.delete(p);
            portLanguages.delete(p);
            updateConnectionStatus(activeSockets.size > 0);
        };

        socket.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'pong') return;
                    handleMessage(data, p);
                } catch (e) {}
            } else {
                handleBinaryMessage(event.data, p);
            }
        };
    } catch (e) {
        log(`Failed connection to ${port}: ${(e as any)?.message ?? e}`);
    }
}

function handleBinaryMessage(buffer, port) {
    try {
        log(`Binary Data Received: ${buffer.byteLength} bytes`);
        
        if (buffer.byteLength < 4) {
            log('Error: Buffer too small');
            return;
        }

        const view = new DataView(buffer);
        const metaLen = view.getUint32(0, false);
        log(`Meta Length: ${metaLen}`);
        
        if (buffer.byteLength < 4 + metaLen) {
            log(`Error: Truncated buffer (${buffer.byteLength} < ${4 + metaLen})`);
            return;
        }

        const decoder = new TextDecoder();
        const metaBytes = new Uint8Array(buffer, 4, metaLen);
        const metaJson = decoder.decode(metaBytes);
        const metadata = JSON.parse(metaJson);
        const pid = metadata.id ? String(metadata.id) : null;
        // Normalize snap points: older servers unbox a single point to scalars
        // ({"x":5,"y":7}); coerce to arrays so downstream code never special-cases.
        metadata.points = normalizeSnapPoints(metadata.points);
        if (metadata.points) {
            log(`Hover-snap points received: ${metadata.points.x.length}`);
        }
        
        const payload = new Uint8Array(buffer, 4 + metaLen);
        log(`Payload length: ${payload.byteLength} bytes`);

        // Sniff format if unknown or to verify (decision logic lives in the core).
        const sniff = payload.byteLength > 10 ? new TextDecoder().decode(payload.slice(0, 50)) : '';
        const mimeType = RPlotCore.sniffImageMime(sniff, metadata.format, payload.byteLength);
        log(`Sniffed format: ${mimeType}`);

        const blob = new Blob([payload], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        if (pid && plotUrls.has(pid)) {
            URL.revokeObjectURL(plotUrls.get(pid));
        }
        if (pid) plotUrls.set(pid, url);
        
        if (metadata.type === 'new_plot') {
            addPlot(url, metadata, port);
        } else {
            updateCurrentPlot(pid, url, port, metadata.coords, metadata.points);
        }
    } catch (e) {
        log('CRITICAL ERROR: ' + e);
        const statusText = document.getElementById('statusText');
        if (statusText) statusText.textContent = 'Data Error';
    }
}

function initThumbObserver() {
    if (!thumbObserver) {
        thumbObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const pid = img.getAttribute('data-id');
                    if (pid && !plotUrls.has(pid)) {
                        broadcastToBackends({ type: 'request_binary', plot_id: pid });
                    }
                    thumbObserver.unobserve(img);
                }
            });
        }, { root: document.getElementById('plotList'), threshold: 0.1 });
    }
    
    document.querySelectorAll('.lazy-thumb').forEach(img => {
        const pid = img.getAttribute('data-id');
        if (plotUrls.has(pid)) {
            img.src = plotUrls.get(pid);
        } else {
            log('Requesting binary for lazy thumb: ' + pid);
            thumbObserver.observe(img);
        }
    });
}

// Drag to pan functionality
(function() {
    const container = document.getElementById('plotContainer');
    let isDragging = false;
    let startX, startY, scrollLeft, scrollTop;
    
    container.addEventListener('mousedown', (e) => {
        // Only enable drag if content is scrollable
        if (container.scrollWidth > container.clientWidth || container.scrollHeight > container.clientHeight) {
            isDragging = true;
            container.classList.add('dragging');
            startX = e.pageX - container.offsetLeft;
            startY = e.pageY - container.offsetTop;
            scrollLeft = container.scrollLeft;
            scrollTop = container.scrollTop;
        }
    });
    
    container.addEventListener('mouseleave', () => {
        isDragging = false;
        container.classList.remove('dragging');
    });
    
    container.addEventListener('mouseup', () => {
        isDragging = false;
        container.classList.remove('dragging');
    });
    
    container.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const x = e.pageX - container.offsetLeft;
        const y = e.pageY - container.offsetTop;
        const walkX = (x - startX) * 1.5; // Scroll speed multiplier
        const walkY = (y - startY) * 1.5;
        container.scrollLeft = scrollLeft - walkX;
        container.scrollTop = scrollTop - walkY;
    });
})();

function handleMessage(data, port) {
    switch (data.type) {
        case 'new_plot': addPlot(data.data, data.metadata, port); break;
        case 'update_plot': 
            // This is likely legacy or fallback, but let's fix the signature
            if (data.id && data.data) updateCurrentPlot(data.id, data.data, port); 
            break;
        case 'clear_plots': clearLocalPlots(); break;
        case 'plot_list': 
            // Server is the source of truth for plot data
            const serverPlots = data.plots || [];
            const savedState = vscode.getState() || {};
            const savedPlots = savedState.plots || [];
            
            // Create a map of saved metadata by ID for quick lookup
            const savedMetadataMap = new Map();
            savedPlots.forEach(sp => {
                if (sp.id) {
                    savedMetadataMap.set(sp.id, {
                        note: sp.note || '',
                        isFavorite: sp.isFavorite || false
                    });
                }
            });
            
            // Merge: use server data but restore client metadata if ID matches
            const incomingPlots = serverPlots.map(serverPlot => {
                // Prefer durable workspace metadata; fall back to webview state.
                const savedMetadata = savedMetaMap.get(serverPlot.id) || savedMetadataMap.get(serverPlot.id);
                return {
                    ...serverPlot,
                    data: plotUrls.get(serverPlot.id) || '', // Restore URL if we have it
                    note: savedMetadata?.note || '',
                    isFavorite: savedMetadata?.isFavorite || false
                };
            });
            
            // Multi-terminal stability + archive survival: handled by the typed,
            // unit-tested core (keeps other live ports, keeps archived plots, and
            // lets a live plot supersede its archived copy of the same id).
            plots = RPlotCore.mergePlotLists(plots, incomingPlots, port);

            rehydratePlots();
            persistArchive();
            break;
    }
}

async function exportAsFormat(format, opts = {}) {
    if (currentIndex < 0) return;
    const plot = plots[currentIndex];
    const hasAnnotation = lastCanvasData.has(String(plot.id));

    log(`Preparing export for plot ${plot.id} as ${format} (Has annotation: ${hasAnnotation})`);

    // Case 1: Pure SVG (Only for single view)
    if (!isSplitMode && plot.format === 'svg' && format === 'svg' && !hasAnnotation) {
        log('Direct SVG export...');
        try {
            const response = await fetch(plot.data);
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onloadend = () => {
                vscode.postMessage({ command: 'save_data', data: reader.result, format: 'svg' });
            };
            reader.readAsDataURL(blob);
            return;
        } catch (e) {
            log('Direct SVG export failed: ' + e);
        }
    }

    // Case 2: SVG export with annotations -> Generate Composite SVG
    if (format === 'svg') {
        log('Generating composite SVG...');
        let compositeData;
        if (isSplitMode) {
            compositeData = await generateSplitCompositeSVG(plots[leftIndex], plots[rightIndex]);
        } else if (hasAnnotation) {
            compositeData = await generateCompositeSVG(plot);
        }

        if (compositeData) {
            vscode.postMessage({ command: 'save_data', data: compositeData, format: 'svg' });
            return;
        }
    }

    // Case 3: Raster (PNG) / PDF (raster embedded) / Fallback
    const deliverRaster = (blob) => {
        if (!blob) {
            log('Failed to create plot blob');
            vscode.postMessage({ command: 'info', text: 'Export failed: Could not process image' });
            return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
            if (format === 'pdf') {
                deliverPdf(reader.result);
            } else {
                vscode.postMessage({ command: 'save_data', data: reader.result, format: format });
            }
        };
        reader.readAsDataURL(blob);
    };

    if (isSplitMode) {
        getSplitCombinedBlob(plots[leftIndex], plots[rightIndex], deliverRaster, opts);
    } else {
        getCombinedPlotBlob(plot, deliverRaster, opts);
    }
}

// Wrap a PNG data URL in a single-page PDF sized to the image, using the bundled
// jsPDF. Keeps PDF export dependency-light and fully offline.
function deliverPdf(pngDataUrl) {
    try {
        const w = window as any; // jsPDF UMD global, loaded via a separate script tag
        const jsPDFCtor = (w.jspdf && w.jspdf.jsPDF) || w.jsPDF;
        if (!jsPDFCtor) {
            vscode.postMessage({ command: 'info', text: 'PDF export unavailable: library not loaded' });
            return;
        }
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth || 800;
            const h = img.naturalHeight || 600;
            const doc = new jsPDFCtor({
                orientation: w >= h ? 'landscape' : 'portrait',
                unit: 'px',
                format: [w, h]
            });
            doc.addImage(pngDataUrl, 'PNG', 0, 0, w, h);
            const pdfDataUri = doc.output('datauristring');
            vscode.postMessage({ command: 'save_data', data: pdfDataUri, format: 'pdf' });
        };
        img.onerror = () => {
            vscode.postMessage({ command: 'info', text: 'PDF export failed: could not read image' });
        };
        img.src = pngDataUrl;
    } catch (e) {
        log('PDF export failed: ' + e);
        vscode.postMessage({ command: 'info', text: 'PDF export failed' });
    }
}

async function generateCompositeSVG(plot) {
    try {
        const annotationData = lastCanvasData.get(String(plot.id));
        if (!annotationData) return null;

        // Fetch original plot as data URL to make SVG portable
        const basePlotData = await new Promise((res) => {
            fetch(plot.data).then(r => r.blob()).then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => res(reader.result);
                reader.readAsDataURL(blob);
            }).catch(() => res(plot.data));
        });

        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = plot.data;
        });

        const w = img.naturalWidth || 800;
        const h = img.naturalHeight || 600;

        // Create a wrapper SVG that embeds the original and the annotation
        const svg = `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <image href="${basePlotData}" width="${w}" height="${h}" />
    <image href="${annotationData}" width="${w}" height="${h}" />
</svg>`.trim();

        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    } catch (e) {
        log('Composite SVG generation failed: ' + e);
        return null;
    }
}

function rehydratePlots() {
    updatePlotList(); 
    
    // Handle sidebar state
    if (state.sidebarHidden) {
        document.querySelector('.sidebar').classList.add('sidebar-hidden');
    }
    
    // Restore state and keep active plot valid
    if (plots.length > 0) {
        if (currentIndex >= plots.length) currentIndex = plots.length - 1;
        if (currentIndex < 0) currentIndex = 0;
        showPlot(currentIndex, false);
    } else {
        clearLocalPlots();
    }
}

function updateConnectionStatus(connected) {
    const dot = document.getElementById('statusDot');
    const logosContainer = document.getElementById('statusLogos');
    
    if (connected) {
        dot.classList.add('connected');
        
        // Determine unique active languages
        const connectedLangs = new Set();
        for (const [port, socket] of activeSockets) {
            if (socket.readyState === WebSocket.OPEN) {
                const lang = portLanguages.get(port);
                if (lang) connectedLangs.add(lang);
            }
        }
        
        // Update logos
        if (logosContainer) {
            logosContainer.innerHTML = '';
            
            // Sort to keep order consistent (R then Julia or vice versa)
            const sortedLangs = Array.from(connectedLangs).sort(); 
            
            if (sortedLangs.length === 0) {
                const activeText = document.createElement('span');
                activeText.textContent = 'Active';
                activeText.style.fontSize = '10px';
                logosContainer.appendChild(activeText);
            } else {
                sortedLangs.forEach((lang: any) => {
                    const logoSvg = LOGOS[lang.toLowerCase()];
                    if (logoSvg) {
                        const div = document.createElement('div');
                        div.innerHTML = logoSvg;
                        div.title = lang.charAt(0).toUpperCase() + lang.slice(1) + ' Active';
                        logosContainer.appendChild(div.firstChild);
                    }
                });
            }
        }
    } else {
        dot.classList.remove('connected');
        if (logosContainer) {
            logosContainer.innerHTML = '<span style="font-size: 10px; opacity: 0.6;">Offline</span>';
        }
    }
}


function addPlot(plotUrl, metadata: any = {}, port?) {
    const pid = metadata.id ? String(metadata.id) : String(Date.now());
    
    // Deduplication check: if plot already exists, treat as update
    const existingIdx = plots.findIndex(p => String(p.id) === pid);
    if (existingIdx >= 0) {
        log(`Idempotent addPlot: Updating existing plot ${pid}`);
        updateCurrentPlot(pid, plotUrl, port);
        return;
    }
    
    const plot = {
        id: pid,
        data: plotUrl,
        format: metadata.format || 'svg',
        timestamp: metadata.timestamp || new Date().toLocaleTimeString(),
        note: metadata.note || '',
        isFavorite: metadata.isFavorite || false,
        // Source provenance captured by the R server (for the code-actions menu).
        code: metadata.code || '',
        srcFile: metadata.srcFile || '',
        srcLine1: metadata.srcLine1,
        srcLine2: metadata.srcLine2,
        coords: metadata.coords, // base-graphics transform for hover-to-inspect (may be undefined)
        points: metadata.points, // plotted data points for hover-snapping (may be undefined)
        port: Number(port)
    };
    plots.push(plot);
    currentIndex = plots.length - 1;

    updatePlotList();
    showPlot(currentIndex, true);
    persistArchive();
}

function updateCurrentPlot(plotId, plotUrl, port, coords?, points?) {
    const pid = String(plotId);
    const index = plots.findIndex(p => String(p.id) === pid);
    if (index >= 0) {
        plots[index].data = plotUrl;
        if (port) plots[index].port = Number(port);
        if (coords !== undefined) plots[index].coords = coords;
        if (points !== undefined) plots[index].points = points;
        
        if (!isSplitMode && index === currentIndex) {
            const plotImage = document.getElementById('plotImage');
            const wrapper = document.getElementById('mainMediaWrapper');
            if (plotImage) {
                // Preload and swap
                plotImage.classList.add('changing');
                const tempImg = new Image();
                tempImg.onload = () => {
                    setTimeout(() => {
                        plotImage.src = plotUrl;
                        plotImage.classList.remove('changing');
                        plotImage.style.display = 'block';
                        if (wrapper) {
                            wrapper.style.display = 'inline-block';
                            updatePlotDimensions('mainMediaWrapper');
                        }
                        document.getElementById('emptyState').style.display = 'none';
                        restoreAnnotation(pid, 'annotationCanvas');
                    }, 100);
                };
                tempImg.src = plotUrl;
            }
        }
        
        // Update split views
        if (isSplitMode) {
            if (index === leftIndex) {
                const leftPlot = document.getElementById('leftPlot');
                const leftWrapper = document.getElementById('leftMediaWrapper');
                if (leftPlot) {
                    leftPlot.classList.add('changing');
                    const tempImg = new Image();
                    tempImg.onload = () => {
                        leftPlot.src = plotUrl;
                        leftPlot.classList.remove('changing');
                        if (leftWrapper) {
                            leftWrapper.style.display = 'inline-block';
                            updatePlotDimensions('leftMediaWrapper');
                        }
                        document.getElementById('emptyState').style.display = 'none';
                        restoreAnnotation(pid, 'leftAnnotationCanvas');
                    };
                    tempImg.src = plotUrl;
                }
            }
            if (index === rightIndex) {
                const rightPlot = document.getElementById('rightPlot');
                const rightWrapper = document.getElementById('rightMediaWrapper');
                if (rightPlot) {
                    rightPlot.classList.add('changing');
                    const tempImg = new Image();
                    tempImg.onload = () => {
                        rightPlot.src = plotUrl;
                        rightPlot.classList.remove('changing');
                        if (rightWrapper) {
                            rightWrapper.style.display = 'inline-block';
                            updatePlotDimensions('rightMediaWrapper');
                        }
                        document.getElementById('emptyState').style.display = 'none';
                        restoreAnnotation(pid, 'rightAnnotationCanvas');
                    };
                    tempImg.src = plotUrl;
                }
            }
        }
        
        const thumbItem = document.getElementById('thumb-' + index);
        if (thumbItem) {
            thumbItem.src = plotUrl;
        }
    }
}

function clearLocalPlots() {
    plots = [];
    currentIndex = -1;
    leftIndex = -1;
    rightIndex = -1;
    
    // Clear stored annotations
    lastCanvasData.clear();
    
    // Revoke all Object URLs
    plotUrls.forEach(url => URL.revokeObjectURL(url));
    plotUrls.clear();
    
    // Reset split mode if active
    if (isSplitMode) {
        isSplitMode = false;
        document.body.classList.remove('is-split-mode');
        const splitBtn = document.getElementById('splitBtn');
        if (splitBtn) splitBtn.classList.remove('split-active-btn');
    }
    
    // Hide all wrappers and clear canvases
    const wrappers = ['mainMediaWrapper', 'leftMediaWrapper', 'rightMediaWrapper'];
    const canvases = ['annotationCanvas', 'leftAnnotationCanvas', 'rightAnnotationCanvas'];
    
    wrappers.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    
    canvases.forEach(id => {
        const c = document.getElementById(id);
        if (c) {
            const ctx = c.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, c.width, c.height);
        }
    });
    
    const plotImage = document.getElementById('plotImage');
    if (plotImage) plotImage.style.display = 'none';
    
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.style.display = 'block';

    const splitContainer = document.getElementById('splitViewContainer');
    if (splitContainer) splitContainer.style.display = 'none';

    // Update state to remove annotations and reset indices
    vscode.setState({ 
        ...vscode.getState(), 
        currentIndex: -1, 
        plots: [], 
        isSplitMode: false,
        leftIndex: -1,
        rightIndex: -1,
        annotations: undefined
    });
    
    updatePlotList();
    updateControls();
    saveState();
}

// Delete Handler
function deletePlot(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= plots.length) return;
    
    const plot = plots[index];
    const pid = plot.id;
    
    log(`Optimistic delete: Plot ${pid} (index ${index})`);

    // 1. Broadcast to backends
    broadcastToBackends({ type: 'delete_plot', plot_id: pid });
    
    // 2. Optimistic local removal
    plots.splice(index, 1);
    
    // 3. Resource cleanup
    if (plotUrls.has(pid)) {
        URL.revokeObjectURL(plotUrls.get(pid));
        plotUrls.delete(pid);
    }
    lastCanvasData.delete(pid);
    
    // 4. Adjust Indices
    if (currentIndex === index) {
        currentIndex = plots.length > 0 ? Math.max(0, index - 1) : -1;
    } else if (currentIndex > index) {
        currentIndex--;
    }
    
    if (leftIndex === index) leftIndex = -1;
    else if (leftIndex > index) leftIndex--;
    
    if (rightIndex === index) rightIndex = -1;
    else if (rightIndex > index) rightIndex--;

    // 5. Update state and UI
    saveState();
    persistMeta();
    persistArchive();
    updatePlotList();

    if (plots.length > 0) {
        showPlot(currentIndex, false);
    } else {
        clearLocalPlots();
    }
}

function createPlotItemHTML(plot, index) {
    const isActive = index === currentIndex ? 'active' : '';
    let splitClass = '';
    if (isSplitMode) {
        if (index === leftIndex) splitClass = 'selected-left';
        if (index === rightIndex) splitClass = 'selected-right';
    }
    
    const favoriteClass = plot.isFavorite ? 'active' : '';
    const noteClass = plot.note ? 'has-note' : '';
    const favoriteTitle = plot.isFavorite ? 'Remove from favorites' : 'Add to favorites';
    const noteTitle = plot.note ? 'Edit note' : 'Add note';
    const annoClass = lastCanvasData.has(String(plot.id)) ? 'has-annotation' : '';

    let html = '<div class="plot-item ' + isActive + ' ' + splitClass + ' ' + annoClass + '" id="plot-item-' + index + '" ';
    html += 'onclick="showPlot(' + index + ')" ';
    html += 'draggable="true" ';
    html += 'ondragstart="handleDragStart(event, ' + index + ')" ';
    html += 'ondragend="handleDragEnd(event)">';
    
    // Split selection controls
    if (isSplitMode) {
        html += '<div class="sidebar-select left-btn ' + (index === leftIndex ? 'selected' : '') + '" onclick="setSplitPosition(' + index + ', \'left\', event)" title="View on Left">L</div>';
        html += '<div class="sidebar-select right-btn ' + (index === rightIndex ? 'selected' : '') + '" onclick="setSplitPosition(' + index + ', \'right\', event)" style="left: 30px;" title="View on Right">R</div>';
    }

    const src = plotUrls.get(plot.id) || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg=='; 
    html += '<img class="lazy-thumb" data-id="' + plot.id + '" src="' + src + '" loading="lazy" alt="Plot ' + (index + 1) + '" id="thumb-' + index + '"/>';
    // Marker for plots carrying annotations (baked into every export).
    html += '<div class="annotation-badge" title="Annotated (included in exports)">✎</div>';
    html += '<div class="thumbnail-footer">';
    html += '<div class="plot-meta">';
    html += '<div class="plot-index" style="font-weight:600">Plot ' + (index + 1) + '</div>';
    html += '<div class="plot-time">' + plot.timestamp + '</div>';
    html += '</div>';
    html += '<div class="thumbnail-actions">';
    html += '<div class="favorite-btn ' + favoriteClass + '" onclick="toggleFavorite(' + index + ', event)" title="' + favoriteTitle + '">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" /></svg>';
    html += '</div>';
    html += '<div class="note-btn ' + noteClass + '" onclick="showNoteDialog(' + index + ', event)" title="' + noteTitle + '">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-notes"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M5 3m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z" /><path d="M9 7l6 0" /><path d="M9 11l6 0" /><path d="M9 15l4 0" /></svg>';
    html += '</div>';
    html += '<div class="delete-btn" onclick="deletePlot(' + index + ', event)" title="Delete">';
    html += '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-xbox-x"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 2c5.523 0 10 4.477 10 10s-4.477 10 -10 10s-10 -4.477 -10 -10s4.477 -10 10 -10m3.6 5.2a1 1 0 0 0 -1.4 .2l-2.2 2.933l-2.2 -2.933a1 1 0 1 0 -1.6 1.2l2.55 3.4l-2.55 3.4a1 1 0 1 0 1.6 1.2l2.2 -2.933l2.2 2.933a1 1 0 0 0 1.6 -1.2l-2.55 -3.4l2.55 -3.4a1 1 0 0 0 -.2 -1.4" /></svg>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
    
    return html;
}

function updatePlotList() {
    const listEl = document.getElementById('plotList');
    if (!listEl) return;
    
    listEl.classList.toggle('is-split-mode', isSplitMode);
    
    // Disconnect old observer to re-observe new items
    if (thumbObserver) thumbObserver.disconnect();
    
    const badge = document.getElementById('countBadge');
    if (badge) badge.textContent = String(plots.length);

    if (plots.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;opacity:0.5; font-style: italic;">No history</div>';
        return;
    }
    
    const displayPlots = showOnlyFavorites ? plots.filter(p => p.isFavorite) : plots;
    
    if (displayPlots.length === 0 && showOnlyFavorites) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;opacity:0.5; font-style: italic;">No favorites</div>';
        return;
    }
    
    listEl.innerHTML = displayPlots.map(plot => {
        const actualIndex = plots.indexOf(plot);
        return createPlotItemHTML(plot, actualIndex);
    }).join('');
    
    initThumbObserver();
}


function showPlot(index, shouldScroll = true) {
    if (index < 0 || index >= plots.length) return;
    
    if (isSplitMode) {
        if (activePane === 'left') leftIndex = index;
        else rightIndex = index;
        currentIndex = index;
        
        // Update label
        const paneLabel = document.getElementById(activePane + 'PaneLabel');
        if (paneLabel) paneLabel.textContent = 'Plot ' + (index + 1);
    } else {
        currentIndex = index;
    }
    
    const plot = plots[index];
    const pid = plot.id;
    
    saveState();
    
    // Update main image or split image
    const plotUrl = plotUrls.get(pid);
    if (plotUrl) {
        if (isSplitMode) {
            const paneImg = document.getElementById(activePane + 'Plot');
            const wrapper = document.getElementById(activePane + 'MediaWrapper');
            if (paneImg) {
                paneImg.classList.add('changing');
                const tempImg = new Image();
                tempImg.onload = () => {
                    paneImg.src = plotUrl;
                    paneImg.classList.remove('changing');
                    if (wrapper) {
                        wrapper.style.display = 'inline-block';
                        updatePlotDimensions(activePane + 'MediaWrapper');
                    }
                    document.getElementById('emptyState').style.display = 'none';
                    restoreAnnotation(pid, activePane + 'AnnotationCanvas');
                };
                tempImg.src = plotUrl;
            }
        } else {
            const plotImage = document.getElementById('plotImage');
            const wrapper = document.getElementById('mainMediaWrapper');
            if (plotImage) {
                plotImage.classList.add('changing');
                const tempImg = new Image();
                tempImg.onload = () => {
                    plotImage.src = plotUrl;
                    plotImage.classList.remove('changing');
                    plotImage.style.display = 'block';
                    if (wrapper) {
                        wrapper.style.display = 'inline-block';
                        // Apply this plot's remembered zoom (falls back to the global default).
                        const z = plotZoom.get(String(pid)) || (vscode.getState() || {}).zoomLevel || 'fit';
                        wrapper.classList.remove('zoom-fit', 'zoom-50', 'zoom-75', 'zoom-100', 'zoom-200');
                        wrapper.classList.add('zoom-' + z);
                        updatePlotDimensions('mainMediaWrapper');
                    }
                    document.getElementById('emptyState').style.display = 'none';
                    restoreAnnotation(pid, 'annotationCanvas');
                };
                tempImg.src = plotUrl;
            }
        }
    } else {
        broadcastToBackends({ type: 'request_binary', plot_id: pid });
    }
    
    updateControls();
    updatePlotList();
    
    // Update active state
    if (!isSplitMode) {
        document.querySelectorAll('.plot-item.active').forEach(el => el.classList.remove('active'));
        const activeItem = document.getElementById('plot-item-' + index);
        if (activeItem) {
            activeItem.classList.add('active');
            if (shouldScroll) {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const isHidden = sidebar.classList.toggle('sidebar-hidden');
    
    const currentState = vscode.getState() || {};
    vscode.setState({ ...currentState, sidebarHidden: isHidden });
    
    sendResizeEvent();
}

function openInNewWindow() {
     vscode.postMessage({ command: 'open_new_window' });
}

function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    darkModeUserSet = true; // manual choice pins it, stops following the theme
    document.body.classList.toggle('dark-mode', isDarkMode);

    updateDarkModeUI();

    const currentState = vscode.getState() || {};
    vscode.setState({ ...currentState, darkMode: isDarkMode });
}

function updateDarkModeUI() {
    const darkModeBtn = document.getElementById('darkModeBtn');
    if (!darkModeBtn) return;

    if (isDarkMode) {
        darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 3.34a10 10 0 1 1 -4.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 4.995 -8.336z" /></svg>';
    } else {
        darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /></svg>';
    }
}

function toggleZoom() {
    const side = isSplitMode ? activePane : 'main';
    const wrapperId = isSplitMode ? (activePane + 'MediaWrapper') : 'mainMediaWrapper';
    const target = document.getElementById(wrapperId);
    
    if (!target) return;
    
    const zoomBtn = document.getElementById('zoomBtn');
    const zoomLevels = ['fit', '50', '75', '100', '200'];
    let currentZoom = getZoomFromClass(target);
    
    let idx = zoomLevels.indexOf(currentZoom);
    idx = (idx + 1) % zoomLevels.length;
    const newZoom = zoomLevels[idx];
    
    target.classList.remove('zoom-fit', 'zoom-50', 'zoom-75', 'zoom-100', 'zoom-200');
    target.classList.add('zoom-' + newZoom);
    
    updatePlotDimensions(wrapperId);
    showZoomNotification(newZoom);
    if (newZoom === 'fit') {
        zoomBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-zoom-pan"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /\u003e\u003cpath d="M17 17l-2.5 -2.5" /\u003e\u003cpath d="M10 4l2 -2l2 2" /\u003e\u003cpath d="M20 10l2 2l-2 2" /\u003e\u003cpath d="M4 10l-2 2l2 2" /\u003e\u003cpath d="M10 20l2 2l2 -2" /\u003e\u003c/svg\u003e';
    } else {
        zoomBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-zoom-pan"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M12 8a4 4 0 0 1 3.447 6.031l2.26 2.262a1 1 0 0 1 -1.414 1.414l-2.262 -2.26a4 4 0 0 1 -6.031 -3.447l.005 -.2a4 4 0 0 1 3.995 -3.8" /\u003e\u003cpath d="M11.293 1.293a1 1 0 0 1 1.414 0l2 2a1 1 0 1 1 -1.414 1.414l-1.293 -1.292l-1.293 1.292a1 1 0 0 1 -1.32 .083l-.094 -.083a1 1 0 0 1 0 -1.414z" /\u003e\u003cpath d="M19.293 9.293a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 -1.414l1.292 -1.293l-1.292 -1.293a1 1 0 0 1 -.083 -1.32z" /\u003e\u003cpath d="M3.293 9.293a1 1 0 1 1 1.414 1.414l-1.292 1.293l1.292 1.293a1 1 0 0 1 .083 1.32l-.083 .094a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414z" /\u003e\u003cpath d="M9.293 19.293a1 1 0 0 1 1.414 0l1.293 1.292l1.294 -1.292a1 1 0 0 1 1.32 -.083l.094 .083a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414" /\u003e\u003c/svg\u003e';
    }
    
    showZoomNotification(newZoom);
    // Only save global state if not in split mode, or use it as a default
    if (!isSplitMode) {
        vscode.setState({ ...vscode.getState(), zoomLevel: newZoom });
        // Remember this zoom for the specific plot too.
        if (currentIndex >= 0 && plots[currentIndex]) {
            plotZoom.set(String(plots[currentIndex].id), newZoom);
            saveState();
        }
    }

    // Refresh annotations for visible canvases
    if (isSplitMode) {
        if (leftIndex >= 0) restoreAnnotation(plots[leftIndex].id, 'leftAnnotationCanvas');
        if (rightIndex >= 0) restoreAnnotation(plots[rightIndex].id, 'rightAnnotationCanvas');
    } else if (currentIndex >= 0 && plots[currentIndex]) {
        restoreAnnotation(plots[currentIndex].id, 'annotationCanvas');
    }

    // Re-sync annotation context if active
    if (isAnnotating) {
        setupActiveCanvas();
    }

    // Sync with backend for high-quality re-render if zoom affects perceived size
    setTimeout(() => sendResizeEvent(), 50);
}

function toggleAspectRatio() {
    const side = isSplitMode ? activePane : 'main';
    const wrapperId = isSplitMode ? (activePane + 'MediaWrapper') : 'mainMediaWrapper';
    const target = document.getElementById(wrapperId);
    
    if (!target) return;
    
    const aspectBtn = document.getElementById('aspectBtn');
    const aspectRatios = ['auto', 'square', 'landscape', 'portrait', 'fill'];
    let currentAspect = getScaleFromClass(target);
    
    let idx = aspectRatios.indexOf(currentAspect);
    idx = (idx + 1) % aspectRatios.length;
    const newAspect = aspectRatios[idx];
    
    target.classList.remove('aspect-auto', 'aspect-square', 'aspect-landscape', 'aspect-portrait', 'aspect-fill');
    target.classList.add('aspect-' + newAspect);
    
    updatePlotDimensions(wrapperId);
    
    // Manage .has-aspect class for CSS targeting
    const isFixedAspect = newAspect !== 'auto' && newAspect !== 'fill';
    target.classList.toggle('has-aspect', isFixedAspect);
    
    // Refresh annotations for visible canvases
    if (isSplitMode) {
        if (leftIndex >= 0) restoreAnnotation(plots[leftIndex].id, 'leftAnnotationCanvas');
        if (rightIndex >= 0) restoreAnnotation(plots[rightIndex].id, 'rightAnnotationCanvas');
    } else if (currentIndex >= 0 && plots[currentIndex]) {
        restoreAnnotation(plots[currentIndex].id, 'annotationCanvas');
    }

    // Re-sync annotation context if active
    if (isAnnotating) {
        setupActiveCanvas();
    }

    if (newAspect === 'auto') {
        aspectBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M17 3l4 4l-14 14l-4 -4z" /\u003e\u003cpath d="M16 7l-1.5 -1.5" /\u003e\u003cpath d="M13 10l-1.5 -1.5" /\u003e\u003cpath d="M10 13l-1.5 -1.5" /\u003e\u003cpath d="M7 16l-1.5 -1.5" /\u003e\u003c/svg\u003e';
    } else {
        aspectBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2-off"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12.03 7.97l4.97 -4.97l4 4l-5 5m-2 2l-7 7l-4 -4l7 -7" /><path d="M16 7l-1.5 -1.5" /><path d="M13 10l-1.5 -1.5" /><path d="M10 13l-1.5 -1.5" /><path d="M7 16l-1.5 -1.5" /><path d="M3 3l18 18" /></svg>';
    }
    
    showAspectNotification(newAspect);
    if (!isSplitMode) {
        vscode.setState({ ...vscode.getState(), aspectRatio: newAspect });
    }
    // Send resize event with a small delay to allow DOM computation of new layout
    setTimeout(() => sendResizeEvent(), 50);
}

function showAspectNotification(aspectRatio) {
    const notification = document.getElementById('aspectNotification');
    if (!notification) return;
    notification.textContent = aspectRatio.charAt(0).toUpperCase() + aspectRatio.slice(1);
    notification.classList.add('show');
    setTimeout(() => notification.classList.remove('show'), 1500);
}

function updateControls() {
    const hasPlots = plots.length > 0;
    const canSplit = plots.length >= 2;
    
    // Disable navigation in split mode as it targets single view
    document.getElementById('prevBtn').disabled = !hasPlots || currentIndex === 0 || isSplitMode;
    document.getElementById('nextBtn').disabled = !hasPlots || currentIndex === plots.length - 1 || isSplitMode;
    
    document.getElementById('exportBtn').disabled = !hasPlots;
    document.getElementById('copyBtn').disabled = !hasPlots;
    const codeBtn = document.getElementById('codeBtn');
    if (codeBtn) codeBtn.disabled = !hasPlots || isSplitMode;
    document.getElementById('newWindowBtn').disabled = !hasPlots;
    document.getElementById('clearBtn').disabled = !hasPlots;
    document.getElementById('zoomBtn').disabled = !hasPlots;
    document.getElementById('aspectBtn').disabled = !hasPlots;
    document.getElementById('annotateBtn').disabled = !hasPlots;
    document.getElementById('darkModeBtn').disabled = !hasPlots;
    document.getElementById('favoriteFilterBtn').disabled = !hasPlots;
    
    const splitBtn = document.getElementById('splitBtn');
    if (splitBtn) {
        splitBtn.disabled = !canSplit;
        splitBtn.classList.toggle('split-active-btn', isSplitMode);
    }

    const diffBtn = document.getElementById('diffBtn');
    if (diffBtn) diffBtn.disabled = !canSplit; // needs at least two plots

    document.getElementById('plotInfo').textContent = isSplitMode ? 'SPLIT' : (hasPlots ? `${currentIndex + 1} / ${plots.length}` : '');
}

function previousPlot() { if (currentIndex > 0) showPlot(currentIndex - 1); }
function nextPlot() { if (currentIndex < plots.length - 1) showPlot(currentIndex + 1); }

// Reverse of the plot -> source jump: the extension reports the editor's file and
// cursor line, and we glow the gallery thumbnails whose captured srcref covers that
// line. Purely a highlight, so it never steals the main view.
function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
function basePath(p) { const n = normPath(p); return n.substring(n.lastIndexOf('/') + 1); }

function highlightPlotsForSource(file, line) {
    document.querySelectorAll('.plot-item.source-linked').forEach(el => el.classList.remove('source-linked'));
    if (!file || typeof line !== 'number') return;

    const targetFull = normPath(file);
    const targetBase = basePath(file);
    let firstIdx = -1;

    plots.forEach((plot, idx) => {
        if (!plot.srcFile || typeof plot.srcLine1 !== 'number') return;
        const sameFile = normPath(plot.srcFile) === targetFull || basePath(plot.srcFile) === targetBase;
        if (!sameFile) return;
        const l1 = plot.srcLine1;
        const l2 = (typeof plot.srcLine2 === 'number' && plot.srcLine2 >= l1) ? plot.srcLine2 : l1;
        if (line < l1 || line > l2) return;
        const el = document.getElementById('plot-item-' + idx);
        if (el) el.classList.add('source-linked');
        if (firstIdx < 0) firstIdx = idx;
    });

    if (firstIdx >= 0) {
        const el = document.getElementById('plot-item-' + firstIdx);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function clearAllPlots() {
     broadcastToBackends({ type: 'clear_all' });
     clearLocalPlots();
     // Explicit user action: also wipe the durable gallery archive and metadata.
     vscode.postMessage({ command: 'persist_archive', plots: [] });
     vscode.postMessage({ command: 'persist_meta', meta: [] });
     savedMetaMap = new Map();
}

function exportPlot() {
    if (currentIndex < 0) return;
    vscode.postMessage({ command: 'request_export' });
}

function copyToClipboard() {
    if (currentIndex < 0 || plots.length === 0) {
        log('Copy failed: No plot selected');
        return;
    }

    const processBlob = (blob) => {
        if (!blob) {
            log('Failed to create blob for clipboard');
            return;
        }
        
        const data = [new ClipboardItem({ [blob.type]: blob })];
        navigator.clipboard.write(data).then(() => {
            log('Clipboard write success');
            vscode.postMessage({ command: 'info', text: 'Copied to clipboard' + (isSplitMode ? ' (Split View)' : '') });
        }).catch(err => {
            log('Clipboard API failed: ' + err);
            vscode.postMessage({ command: 'info', text: 'Copy failed: Clipboard access required' });
        });
    };

    if (isSplitMode) {
        getSplitCombinedBlob(plots[leftIndex], plots[rightIndex], processBlob);
    } else {
        getCombinedPlotBlob(plots[currentIndex], processBlob);
    }
}

// Copy the plot's raw SVG markup to the clipboard as text, so it can be pasted into
// a vector editor (Illustrator/Inkscape/Figma) or a source file. Vector plots only.
async function copySvgToClipboard() {
    if (currentIndex < 0 || plots.length === 0) return;
    const plot = plots[currentIndex];
    if (!plot || plot.format !== 'svg' || !plot.data) {
        vscode.postMessage({ command: 'info', text: 'Copy as SVG: this plot is not a vector image' });
        return;
    }
    try {
        const res = await fetch(plot.data);
        const svgText = await res.text();
        await navigator.clipboard.writeText(svgText);
        log('SVG markup copied to clipboard');
        vscode.postMessage({ command: 'info', text: 'SVG copied to clipboard' });
    } catch (err) {
        log('Copy as SVG failed: ' + err);
        vscode.postMessage({ command: 'info', text: 'Copy as SVG failed: clipboard access required' });
    }
}

// --- Pixel diff view ---
// Overlays two plots and paints the pixels that changed, answering "how did this plot
// change when I tweaked the code/parameters?". Picks the pair from the split-view
// selection when active, otherwise the current plot vs the previous one.
let diffA = -1, diffB = -1;

function openDiffView() {
    let a = -1, b = -1;
    if (isSplitMode && leftIndex >= 0 && rightIndex >= 0) {
        a = leftIndex; b = rightIndex;
    } else if (currentIndex >= 1) {
        a = currentIndex - 1; b = currentIndex;
    }
    if (a < 0 || b < 0 || !plots[a] || !plots[b]) {
        vscode.postMessage({ command: 'info', text: 'Diff needs two plots (pick two in Split View, or view a plot after the first)' });
        return;
    }
    diffA = a; diffB = b;
    document.getElementById('diffModal').classList.add('show');
    computeDiff();
}

function closeDiffModal() {
    document.getElementById('diffModal').classList.remove('show');
    diffA = -1; diffB = -1;
}

async function computeDiff() {
    if (diffA < 0 || diffB < 0) return;
    const stats = document.getElementById('diffStats');
    const canvas = document.getElementById('diffCanvas');
    if (!canvas) return;

    try {
        const load = (url): Promise<HTMLImageElement> => new Promise<HTMLImageElement>((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = rej;
            img.src = url;
        });
        const [imgA, imgB] = await Promise.all([load(plots[diffA].data), load(plots[diffB].data)]);

        // Rasterise both onto white canvases of a common size (A's native size).
        const w = imgA.naturalWidth || 800;
        const h = imgA.naturalHeight || 600;
        const mk = (img) => {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const x = c.getContext('2d');
            x.fillStyle = 'white'; x.fillRect(0, 0, w, h);
            x.drawImage(img, 0, 0, w, h);
            return x.getImageData(0, 0, w, h);
        };
        const da = mk(imgA), db = mk(imgB);

        const thrEl = document.getElementById('diffThreshold');
        const threshold = thrEl ? Number(thrEl.value) || 0 : 16;
        const r = RPlotCore.diffPixels(da.data, db.data, { threshold });

        canvas.width = w; canvas.height = h;
        const outCtx = canvas.getContext('2d');
        const outImage = outCtx.createImageData(w, h);
        outImage.data.set(r.out);
        outCtx.putImageData(outImage, 0, 0);

        const pct = r.total ? (100 * r.changed / r.total) : 0;
        if (stats) {
            stats.textContent = `Plot ${diffA + 1} vs Plot ${diffB + 1}: `
                + `${r.changed.toLocaleString()} of ${r.total.toLocaleString()} pixels changed (${pct.toFixed(2)}%)`;
        }
    } catch (e) {
        log('Diff failed: ' + e);
        if (stats) stats.textContent = 'Diff failed: could not rasterise one of the plots';
    }
}

// --- Coordinate inspect tools (hover / measure / zoom-to-region) ---
// All read the base-graphics transform the R server captured (plot.coords) to map
// pixels back to data space. Interactions land on the plot image; drawing goes to a
// dedicated overlay canvas. Only single view, plots with coords, and not while
// annotating.
let inspectTipEl = null;
let inspectMode = 'hover';   // 'hover' | 'measure' | 'crop'
let measurePts = [];         // captured points {px,py,x,y} in measure mode
let cropStart = null;        // {px,py} while dragging a zoom region

function ensureInspectTip() {
    if (inspectTipEl) return inspectTipEl;
    inspectTipEl = document.createElement('div');
    inspectTipEl.className = 'inspect-tip';
    inspectTipEl.style.display = 'none';
    document.body.appendChild(inspectTipEl);
    return inspectTipEl;
}

function inspectActivePlot() {
    const plot = currentIndex >= 0 ? plots[currentIndex] : null;
    if (!hoverInspectEnabled || isAnnotating || isSplitMode || !plot || !plot.coords) return null;
    return plot;
}

function inspectOverlayCtx() {
    const img = document.getElementById('plotImage');
    const overlay = document.getElementById('inspectOverlay');
    if (!img || !overlay) return null;
    // Use the rendered rect (not clientWidth) so overlay pixels match the same
    // coordinate space the mouse handlers measure with getBoundingClientRect.
    const rect = img.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w <= 0 || h <= 0) return null;
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext('2d');
    if (!ctx) return null;
    // Content rect of the letterboxed image, in the same overlay pixel space.
    return { ctx, w, h, img, content: imageContentRect(img) };
}

function clearInspectOverlay() {
    const o = inspectOverlayCtx();
    if (o) o.ctx.clearRect(0, 0, o.w, o.h);
}

function inspectLabel(ctx, text, x, y) {
    ctx.font = '11px monospace';
    const pad = 3, tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(x, y - 12, tw + pad * 2, 15);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + pad, y);
}

// Coerce server-sent snap points to parallel number arrays, or undefined.
// Handles the scalar unboxing of single-point plots and rejects malformed input.
function normalizeSnapPoints(p) {
    if (!p || p.x == null || p.y == null) return undefined;
    const xs = Array.isArray(p.x) ? p.x : [p.x];
    const ys = Array.isArray(p.y) ? p.y : [p.y];
    if (xs.length === 0 || xs.length !== ys.length) return undefined;
    return { x: xs, y: ys };
}

// Rect of the actually drawn image content inside the <img> element box.
// With object-fit: contain the content is centered and letterboxed whenever the
// element box aspect differs from the image's natural aspect; mapping mouse or
// overlay pixels against the element box instead of this rect skews the
// coordinate readout and draws projection lines past the plot panel.
function imageContentRect(img) {
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh || rect.width <= 0 || rect.height <= 0) {
        return { left: rect.left, top: rect.top, offX: 0, offY: 0, w: rect.width, h: rect.height };
    }
    const s = Math.min(rect.width / nw, rect.height / nh);
    const w = nw * s, h = nh * s;
    return {
        left: rect.left, top: rect.top,
        offX: (rect.width - w) / 2, offY: (rect.height - h) / 2,
        w, h
    };
}

function pixelInImage(e, img) {
    const c = imageContentRect(img);
    return { px: e.clientX - c.left - c.offX, py: e.clientY - c.top - c.offY, w: c.w, h: c.h };
}

function drawHoverInspect(plot, px, py, w, h) {
    const o = inspectOverlayCtx();
    if (!o) return;
    o.ctx.clearRect(0, 0, o.w, o.h);
    const tip = ensureInspectTip();

    // Snap to the nearest plotted data point when one is close; otherwise read out the
    // free cursor coordinate.
    let d = RPlotCore.dataAtPixel(px, py, w, h, plot.coords);
    let snapPx = px, snapPy = py, snapped = false;
    if (plot.points && plot.points.x != null && plot.points.y != null) {
        const np = RPlotCore.nearestPoint(px, py, plot.points.x, plot.points.y, w, h, plot.coords, 16);
        if (np) { d = { x: np.x, y: np.y }; snapPx = np.px; snapPy = np.py; snapped = true; }
    }
    // Hide the readout while the cursor is over a letterbox bar, outside the
    // drawn image content.
    if (!d || px < 0 || py < 0 || px > w || py > h) { tip.style.display = 'none'; o.ctx.clearRect(0, 0, o.w, o.h); return; }

    // Positions are in image-content pixels; the overlay covers the whole img
    // element box, so shift by the letterbox offset to land on the content.
    const c = o.content;
    const ox = c.offX + snapPx, oy = c.offY + snapPy;
    const panel = RPlotCore.panelPixelRect(w, h, plot.coords);
    const bottom = (panel ? panel.bottom : h) + c.offY;
    const left = (panel ? panel.left : 0) + c.offX;

    o.ctx.strokeStyle = 'rgba(255,64,129,0.9)';
    o.ctx.lineWidth = 1;
    o.ctx.setLineDash([4, 3]);
    o.ctx.beginPath();
    o.ctx.moveTo(ox, oy); o.ctx.lineTo(ox, bottom);
    o.ctx.moveTo(ox, oy); o.ctx.lineTo(left, oy);
    o.ctx.stroke();
    o.ctx.setLineDash([]);
    // Ring the snapped data point so it is clearly the exact value, not the free cursor.
    if (snapped) {
        o.ctx.fillStyle = 'rgba(255,64,129,0.95)';
        o.ctx.beginPath(); o.ctx.arc(ox, oy, 4, 0, 7); o.ctx.fill();
        o.ctx.strokeStyle = '#fff'; o.ctx.lineWidth = 1.5;
        o.ctx.beginPath(); o.ctx.arc(ox, oy, 4, 0, 7); o.ctx.stroke();
    }
    inspectLabel(o.ctx, RPlotCore.formatInspectValue(d.x), ox + 2, bottom - 3);
    inspectLabel(o.ctx, RPlotCore.formatInspectValue(d.y), left + 3, oy - 2);

    tip.textContent = (snapped ? '● ' : '') + `x: ${RPlotCore.formatInspectValue(d.x)}    y: ${RPlotCore.formatInspectValue(d.y)}`;
    tip.style.display = 'block';
    tip.style.left = (px + c.left + c.offX + 14) + 'px';
    tip.style.top = (py + c.top + c.offY + 14) + 'px';
}

function drawMeasure(plot, curPx, curPy, w, h) {
    const o = inspectOverlayCtx();
    if (!o) return;
    o.ctx.clearRect(0, 0, o.w, o.h);
    // Content-pixel positions; shift by the letterbox offset onto the overlay.
    const fx = o.content.offX, fy = o.content.offY;
    const tip = ensureInspectTip();
    const pts = measurePts.slice();
    const live = pts.length === 1 ? { px: curPx, py: curPy } : null;
    const a = pts[0], b = pts[1] || live;
    o.ctx.fillStyle = o.ctx.strokeStyle = 'rgba(255,64,129,0.95)';
    for (const p of pts) { o.ctx.beginPath(); o.ctx.arc(p.px + fx, p.py + fy, 3, 0, 7); o.ctx.fill(); }
    if (a && b) {
        o.ctx.lineWidth = 1.5;
        o.ctx.beginPath(); o.ctx.moveTo(a.px + fx, a.py + fy); o.ctx.lineTo(b.px + fx, b.py + fy); o.ctx.stroke();
        const da = RPlotCore.dataAtPixel(a.px, a.py, w, h, plot.coords);
        const db = RPlotCore.dataAtPixel(b.px, b.py, w, h, plot.coords);
        if (da && db) {
            const dx = db.x - da.x, dy = db.y - da.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const txt = `Δx: ${RPlotCore.formatInspectValue(dx)}   Δy: ${RPlotCore.formatInspectValue(dy)}   |d|: ${RPlotCore.formatInspectValue(dist)}`;
            inspectLabel(o.ctx, txt, Math.min(a.px, b.px) + fx, Math.min(a.py, b.py) + fy - 4);
            tip.style.display = 'none';
        }
    }
}

function drawCrop(curPx, curPy, w, h) {
    const o = inspectOverlayCtx();
    if (!o || !cropStart) return;
    o.ctx.clearRect(0, 0, o.w, o.h);
    const fx = o.content.offX, fy = o.content.offY;
    const x = cropStart.px + fx, y = cropStart.py + fy;
    const cw = curPx - cropStart.px, ch = curPy - cropStart.py;
    o.ctx.strokeStyle = 'rgba(30,144,255,0.95)';
    o.ctx.fillStyle = 'rgba(30,144,255,0.12)';
    o.ctx.lineWidth = 1;
    o.ctx.fillRect(x, y, cw, ch);
    o.ctx.strokeRect(x, y, cw, ch);
}

function zoomNumber(v) { return String(Number(v.toPrecision(6))); }

function commitCrop(plot, endPx, endPy, w, h) {
    const p0 = RPlotCore.dataAtPixel(cropStart.px, cropStart.py, w, h, plot.coords);
    const p1 = RPlotCore.dataAtPixel(endPx, endPy, w, h, plot.coords);
    cropStart = null;
    clearInspectOverlay();
    if (!p0 || !p1) return;
    if (Math.abs(p1.x - p0.x) < 1e-12 || Math.abs(p1.y - p0.y) < 1e-12) return;
    const xlim = [Math.min(p0.x, p1.x), Math.max(p0.x, p1.x)];
    const ylim = [Math.min(p0.y, p1.y), Math.max(p0.y, p1.y)];
    // ggplot panels get a ready-to-add coord_cartesian layer; base plots get
    // xlim/ylim variables for the next plot call.
    const cmd = plot.coords && plot.coords.gg
        ? `coord_cartesian(xlim = c(${zoomNumber(xlim[0])}, ${zoomNumber(xlim[1])}), `
            + `ylim = c(${zoomNumber(ylim[0])}, ${zoomNumber(ylim[1])}))  # R Plot Pro zoom region: add to your ggplot`
        : `xlim <- c(${zoomNumber(xlim[0])}, ${zoomNumber(xlim[1])}); `
            + `ylim <- c(${zoomNumber(ylim[0])}, ${zoomNumber(ylim[1])})  # R Plot Pro zoom region`;
    // Type the limits into the R console (without running) so the user can add them to
    // their plot call.
    vscode.postMessage({ command: 'reveal_code', code: cmd });
    vscode.postMessage({ command: 'info', text: 'Zoom limits sent to the R console' });
}

function initHoverInspect() {
    const img = document.getElementById('plotImage');
    if (!img || img.hasInspectListener) return;
    img.hasInspectListener = true;
    ensureInspectTip();

    img.addEventListener('mousemove', (e) => {
        if (laserOn) { ensureInspectTip().style.display = 'none'; clearInspectOverlay(); img.style.cursor = ''; return; }
        const plot = inspectActivePlot();
        if (!plot) { ensureInspectTip().style.display = 'none'; img.style.cursor = ''; clearInspectOverlay(); return; }
        img.style.cursor = 'crosshair';
        const { px, py, w, h } = pixelInImage(e, img);
        if (inspectMode === 'measure') drawMeasure(plot, px, py, w, h);
        else if (inspectMode === 'crop') { if (cropStart) drawCrop(px, py, w, h); }
        else drawHoverInspect(plot, px, py, w, h);
    });
    img.addEventListener('mouseleave', () => {
        ensureInspectTip().style.display = 'none';
        img.style.cursor = '';
        if (inspectMode === 'hover') clearInspectOverlay();
    });
    img.addEventListener('click', (e) => {
        if (laserOn) return;
        const plot = inspectActivePlot();
        if (!plot || inspectMode !== 'measure') return;
        const { px, py, w, h } = pixelInImage(e, img);
        const d = RPlotCore.dataAtPixel(px, py, w, h, plot.coords);
        if (!d) return;
        if (measurePts.length >= 2) measurePts = [];
        measurePts.push({ px, py, x: d.x, y: d.y });
        drawMeasure(plot, px, py, w, h);
    });
    img.addEventListener('mousedown', (e) => {
        if (laserOn) return;
        const plot = inspectActivePlot();
        if (!plot || inspectMode !== 'crop') return;
        const { px, py } = pixelInImage(e, img);
        cropStart = { px, py };
        e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
        if (inspectMode !== 'crop' || !cropStart) return;
        const plot = inspectActivePlot();
        const { px, py, w, h } = pixelInImage(e, img);
        if (plot) commitCrop(plot, px, py, w, h); else { cropStart = null; clearInspectOverlay(); }
    });
}

function setInspectMode(mode) {
    inspectMode = mode;
    measurePts = [];
    cropStart = null;
    clearInspectOverlay();
    ensureInspectTip().style.display = 'none';
}

// --- Laser pointer: a glowing comet-trail pointer, active only over the plot ---
// Recent cursor positions are redrawn every frame with an age-based fade, so
// moving the laser leaves a GoodNotes-style trail that dissolves after ~600ms.
let laserOn = false;
let laserCanvas = null;
let laserTrail = [];          // [{x, y, t}] in viewport pixels
let laserRafId = 0;
let laserOverPlot = false;
let laserDrawing = false;     // mouse button held: leave a trail
let laserHead = null;         // current pointer position while over a plot
const LASER_TRAIL_MS = 700;

// The laser only lights up over an actual plot image (main viewer, split panes
// or the presentation slide), not over toolbars or the gallery.
function laserTargetAt(e) {
    const ids = ['plotImage', 'presImg', 'leftPlot', 'rightPlot'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.offsetParent === null) continue;   // hidden views don't count
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom) return true;
    }
    return false;
}

function ensureLaserCanvas() {
    if (laserCanvas) return laserCanvas;
    laserCanvas = document.createElement('canvas');
    laserCanvas.id = 'laserCanvas';
    laserCanvas.className = 'laser-canvas';
    document.body.appendChild(laserCanvas);
    document.addEventListener('mousemove', (e) => {
        if (!laserOn) return;
        laserOverPlot = laserTargetAt(e);
        document.body.classList.toggle('laser-hide-cursor', laserOverPlot);
        if (!laserOverPlot) { laserHead = null; kickLaserFrame(); return; }
        laserHead = { x: e.clientX, y: e.clientY };
        // Only dragging leaves a trail; plain movement just moves the glow dot.
        if (laserDrawing) {
            const last = laserTrail[laserTrail.length - 1];
            // Thin out sub-pixel jitter for a smoother curve.
            if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 2) {
                laserTrail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
            }
        }
        kickLaserFrame();
    });
    document.addEventListener('mousedown', (e) => {
        if (!laserOn || e.button !== 0 || !laserTargetAt(e)) return;
        laserDrawing = true;
        laserTrail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        kickLaserFrame();
        e.preventDefault();
    });
    window.addEventListener('mouseup', () => { laserDrawing = false; });
    return laserCanvas;
}

function kickLaserFrame() {
    if (!laserRafId) laserRafId = requestAnimationFrame(drawLaserFrame);
}

function drawLaserFrame() {
    laserRafId = 0;
    const c = laserCanvas;
    if (!c) return;
    if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
        c.width = window.innerWidth;
        c.height = window.innerHeight;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);

    const now = performance.now();
    laserTrail = laserTrail.filter(p => now - p.t < LASER_TRAIL_MS);

    // Comet tail rendered as midpoint quadratic curves (smooth through the raw
    // mouse samples) in two passes: a wide soft glow and a narrow bright core.
    // Per-segment alpha/width taper with age, oldest first so fresh strokes
    // sit on top.
    const pts = laserTrail;
    if (pts.length > 1) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const seg = (i) => {
            // Curve piece around pts[i]: from mid(i-1,i) to mid(i,i+1), control pts[i].
            const a = pts[i - 1], b = pts[i], c2 = pts[i + 1] || b;
            const mx1 = (a.x + b.x) / 2, my1 = (a.y + b.y) / 2;
            const mx2 = (b.x + c2.x) / 2, my2 = (b.y + c2.y) / 2;
            ctx.beginPath();
            ctx.moveTo(mx1, my1);
            ctx.quadraticCurveTo(b.x, b.y, mx2, my2);
            ctx.stroke();
        };
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 1; i < pts.length; i++) {
                const age = (now - pts[i].t) / LASER_TRAIL_MS;   // 0 fresh .. 1 gone
                const alpha = Math.max(0, 1 - age);
                const eased = alpha * alpha;                     // gentler tail fade
                if (pass === 0) {
                    ctx.strokeStyle = `rgba(255, 45, 45, ${(eased * 0.28).toFixed(3)})`;
                    ctx.lineWidth = 4 + 8 * eased;
                } else {
                    ctx.strokeStyle = `rgba(255, 70, 70, ${(0.25 + eased * 0.7).toFixed(3)})`;
                    ctx.lineWidth = 1 + 2.5 * eased;
                }
                seg(i);
            }
        }
    }

    // Glowing head follows the cursor whenever it is over a plot.
    if (laserHead && laserOverPlot) {
        const g = ctx.createRadialGradient(laserHead.x, laserHead.y, 0, laserHead.x, laserHead.y, 7);
        g.addColorStop(0, 'rgba(255, 110, 110, 1)');
        g.addColorStop(0.45, 'rgba(255, 45, 45, 0.9)');
        g.addColorStop(1, 'rgba(255, 45, 45, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(laserHead.x, laserHead.y, 7, 0, 7);
        ctx.fill();
    }

    // Keep animating while there is a trail left to fade out.
    if (laserOn && laserTrail.length) {
        laserRafId = requestAnimationFrame(drawLaserFrame);
    }
}

function toggleLaserPointer() {
    laserOn = !laserOn;
    const c = ensureLaserCanvas();
    c.style.display = laserOn ? 'block' : 'none';
    const btn = document.getElementById('laserBtn');
    if (btn) btn.classList.toggle('active', laserOn);
    if (!laserOn) {
        laserTrail = [];
        laserOverPlot = false;
        laserDrawing = false;
        laserHead = null;
        document.body.classList.remove('laser-hide-cursor');
        const ctx = c.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
        if (laserRafId) { cancelAnimationFrame(laserRafId); laserRafId = 0; }
    } else {
        // The laser replaces the inspect readout while it is on.
        if (inspectTipEl) inspectTipEl.style.display = 'none';
        clearInspectOverlay();
    }
}

// --- Presentation mode: full-screen walk through ALL plots with note + code ---
let presOn = false;
let presIdx = 0;
let presShowCode = false;

function buildPresentationOverlay() {
    let el = document.getElementById('presOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'presOverlay';
    el.className = 'pres-overlay';
    el.style.display = 'none';

    const img = document.createElement('img');
    img.id = 'presImg';
    const caption = document.createElement('div');
    caption.id = 'presCaption';
    caption.className = 'pres-caption';
    const counter = document.createElement('div');
    counter.id = 'presCounter';
    counter.className = 'pres-counter';
    const hint = document.createElement('div');
    hint.className = 'pres-hint';
    hint.textContent = '← / → navigate    C code    Esc exit';
    el.append(img, caption, counter, hint);

    // Click on the backdrop (not the image or caption) exits.
    el.addEventListener('click', (e) => { if (e.target === el) exitPresentation(); });
    document.body.appendChild(el);
    return el;
}

function renderPresentation() {
    const plot = plots[presIdx];
    if (!plot) return;
    const img = document.getElementById('presImg');
    img.src = plotUrls.get(plot.id) || plot.data || '';
    const caption = document.getElementById('presCaption');
    caption.textContent = '';
    if (plot.note) {
        const note = document.createElement('div');
        note.className = 'pres-note';
        note.textContent = plot.note;
        caption.appendChild(note);
    }
    if (presShowCode && plot.code && String(plot.code).trim()) {
        const code = document.createElement('pre');
        code.className = 'pres-code';
        code.textContent = plot.code;
        caption.appendChild(code);
    }
    caption.style.display = caption.childNodes.length ? 'block' : 'none';
    document.getElementById('presCounter').textContent = `${presIdx + 1} / ${plots.length}`;
}

function startPresentation() {
    hideSettingsMenu();
    if (!plots.length) {
        vscode.postMessage({ command: 'info', text: 'No plots to present yet' });
        return;
    }
    presIdx = Math.min(Math.max(currentIndex, 0), plots.length - 1);
    presOn = true;
    buildPresentationOverlay().style.display = 'flex';
    renderPresentation();
}

function exitPresentation() {
    presOn = false;
    const el = document.getElementById('presOverlay');
    if (el) el.style.display = 'none';
}

function presNav(dir) {
    if (!plots.length) return;
    presIdx = (presIdx + dir + plots.length) % plots.length;
    renderPresentation();
}

// Combine several plots (favourites if any, else the whole gallery, capped) into one
// grid PNG for reports. Each plot is fit into its cell preserving aspect ratio.
async function exportGridMontage() {
    const favs = plots.filter(p => p.isFavorite);
    const set = (favs.length ? favs : plots).slice(0, 16);
    if (set.length < 2) {
        vscode.postMessage({ command: 'info', text: 'Grid export needs at least two plots (favourite the ones you want)' });
        return;
    }
    try {
        const load = (url): Promise<HTMLImageElement> => new Promise<HTMLImageElement>((res, rej) => {
            const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url;
        });
        const imgs = await Promise.all(set.map(p => load(p.data)));
        const cellW = 500, cellH = 360, gap = 14;
        const layout = RPlotCore.computeGridLayout(imgs.length, cellW, cellH, gap);
        const canvas = document.createElement('canvas');
        canvas.width = layout.canvasW; canvas.height = layout.canvasH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        imgs.forEach((im, i) => {
            const cell = layout.cells[i];
            const nw = im.naturalWidth || 800, nh = im.naturalHeight || 600;
            const r = Math.min(cell.w / nw, cell.h / nh);
            const dw = nw * r, dh = nh * r;
            ctx.drawImage(im, cell.x + (cell.w - dw) / 2, cell.y + (cell.h - dh) / 2, dw, dh);
        });
        canvas.toBlob((blob) => {
            if (!blob) { vscode.postMessage({ command: 'info', text: 'Grid export failed' }); return; }
            const reader = new FileReader();
            reader.onloadend = () => vscode.postMessage({ command: 'save_data', data: reader.result, format: 'png' });
            reader.readAsDataURL(blob);
        }, 'image/png', 0.95);
    } catch (e) {
        log('Grid export failed: ' + e);
        vscode.postMessage({ command: 'info', text: 'Grid export failed' });
    }
}

function refreshLayout() {
     const w = window.innerWidth;
     const h = window.innerHeight;
     if (w < 500 || h > w * 0.85) {
         document.body.classList.add('layout-vertical');
     } else {
         document.body.classList.remove('layout-vertical');
     }
     
     // Recalculate dimensions for all visible wrappers
     if (isSplitMode) {
         updatePlotDimensions('leftMediaWrapper');
         updatePlotDimensions('rightMediaWrapper');
     } else {
         updatePlotDimensions('mainMediaWrapper');
     }
     
     // Verify or attach pan listeners
     setupPanLogic();
}

let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panScrollLeft = 0;
let panScrollTop = 0;
let activePanContainer = null;

function setupPanLogic() {
    const containers = isSplitMode ? 
        [document.getElementById('leftPane'), document.getElementById('rightPane')] : 
        [document.getElementById('plotContainer')];
        
    containers.forEach(container => {
        if (!container || container.hasPanListener) return;
        
        container.addEventListener('mousedown', (e) => {
            // Ignore if clicking on interactive elements or divider
            if (e.target.closest('.icon-btn') || e.target.closest('.split-divider') || isAnnotating) return;
            isPanning = true;
            activePanContainer = container;
            panStartX = e.clientX;
            panStartY = e.clientY;
            panScrollLeft = container.scrollLeft;
            panScrollTop = container.scrollTop;
            container.classList.add('dragging');
            document.body.style.cursor = 'grabbing';
            e.preventDefault(); // Prevent text selection
        });
        
        container.hasPanListener = true;
    });
}

// Global mouse handlers for panning to support dragging outside container
window.addEventListener('mousemove', (e) => {
    if (!isPanning || !activePanContainer) return;
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    const dx = x - panStartX;
    const dy = y - panStartY;
    activePanContainer.scrollLeft = panScrollLeft - dx;
    activePanContainer.scrollTop = panScrollTop - dy;
});

window.addEventListener('mouseup', () => {
    if (isPanning) {
        isPanning = false;
        if (activePanContainer) activePanContainer.classList.remove('dragging');
        activePanContainer = null;
        document.body.style.cursor = '';
    }
});


function sendResizeEvent() {
    let container = document.getElementById('plotContainer');
    if (isSplitMode) {
        container = document.getElementById(activePane + 'Pane');
    }
    
    if (container) {
            let width = Math.floor(container.clientWidth); 
            let height = Math.floor(container.clientHeight);
            
            // Determine aspect ratio from current wrapper classes (not img!)
            const wrapperId = isSplitMode ? (activePane + 'MediaWrapper') : 'mainMediaWrapper';
            const wrapper = document.getElementById(wrapperId);
            
            let aspectRatio = 'auto';
            if (wrapper) {
                const ratios = ['square', 'landscape', 'portrait', 'fill'];
                ratios.forEach(r => { if (wrapper.classList.contains('aspect-' + r)) aspectRatio = r; });
            }
            
            if (aspectRatio === 'square') {
                const size = Math.min(width, height);
                width = height = size;
            } else if (aspectRatio === 'landscape') {
                // Determine fit for 4:3
                const ratio = 4/3;
                if (width / height > ratio) {
                    // Too wide, constrain width
                    width = Math.floor(height * ratio);
                } else {
                    // Too tall, constrain height
                    height = Math.floor(width / ratio);
                }
            } else if (aspectRatio === 'portrait') {
                // Determine fit for 3:4
                const ratio = 3/4;
                if (width / height > ratio) {
                     width = Math.floor(height * ratio);
                } else {
                    height = Math.floor(width / ratio);
                }
            }
            
            let pid;
            if (isSplitMode) {
                const idx = (activePane === 'left' ? leftIndex : rightIndex);
                pid = (idx >= 0 && idx < plots.length) ? plots[idx].id : null;
            } else {
                pid = (currentIndex >= 0 && currentIndex < plots.length) ? plots[currentIndex].id : null;
            }

            if (width > 50 && height > 50) {
                const targetPlot = isSplitMode 
                    ? plots[activePane === 'left' ? leftIndex : rightIndex]
                    : plots[currentIndex];
                    
                const targetPort = targetPlot ? targetPlot.port : null;
                broadcastToBackends({ type: 'resize', width, height, plot_id: pid }, targetPort);
            }
        }
}

window.addEventListener('resize', debounce(() => {
    refreshLayout();
    sendResizeEvent();
}, 200));

function handleDragStart(event, index) {
    event.stopPropagation();
    const plot = plots[index];
    event.target.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('DownloadURL', "image/png:plot_" + (index + 1) + ".png:" + plot.data);
}

function handleDragEnd(event) {
    event.target.classList.remove('dragging');
}

// --- CODE ACTIONS (per-plot dropdown, left of the favorite icon) ---
let codeMenuEl = null;
let codeMenuIndex = -1;

function buildCodeMenu() {
    if (codeMenuEl) return codeMenuEl;
    codeMenuEl = document.createElement('div');
    codeMenuEl.className = 'code-menu';
    codeMenuEl.style.display = 'none';
    codeMenuEl.innerHTML =
        '<div class="code-menu-item" data-act="copy">Copy Code</div>' +
        '<div class="code-menu-item" data-act="reprex">Copy Reproducible Snippet</div>' +
        '<div class="code-menu-item" data-act="reveal">Reveal Code in Console</div>' +
        '<div class="code-menu-item" data-act="run">Run Code Again</div>' +
        '<div class="code-menu-sep"></div>' +
        '<div class="code-menu-item" data-act="card">Export Plot Card (PNG)</div>' +
        '<div class="code-menu-item" data-act="open">Open Source File</div>';
    codeMenuEl.addEventListener('click', (e) => {
        const item = e.target.closest('.code-menu-item');
        if (!item || item.classList.contains('disabled')) { e.stopPropagation(); return; }
        e.stopPropagation();
        const act = item.getAttribute('data-act');
        const idx = codeMenuIndex;
        hideCodeMenu();
        runCodeAction(act, idx);
    });
    document.body.appendChild(codeMenuEl);
    return codeMenuEl;
}

function hideCodeMenu() {
    if (codeMenuEl) codeMenuEl.style.display = 'none';
    codeMenuIndex = -1;
}

function toggleCodeMenu(index, event) {
    if (event) event.stopPropagation();
    const menu = buildCodeMenu();
    if (menu.style.display === 'block' && codeMenuIndex === index) { hideCodeMenu(); return; }
    codeMenuIndex = index;

    // Enable/disable items based on captured metadata.
    const plot = plots[index] || {};
    const hasCode = !!(plot.code && String(plot.code).trim());
    const hasFile = !!(plot.srcFile && String(plot.srcFile).trim());
    menu.querySelector('[data-act="copy"]').classList.toggle('disabled', !hasCode);
    menu.querySelector('[data-act="reprex"]').classList.toggle('disabled', !hasCode);
    menu.querySelector('[data-act="reveal"]').classList.toggle('disabled', !hasCode);
    menu.querySelector('[data-act="run"]').classList.toggle('disabled', !hasCode);
    menu.querySelector('[data-act="open"]').classList.toggle('disabled', !hasFile);
    // 'card' stays enabled: it works from the image + note even without captured code.

    // Position near the clicked button, clamped to the viewport.
    menu.style.display = 'block';
    const rect = (event && event.currentTarget)
        ? event.currentTarget.getBoundingClientRect()
        : { left: 8, right: 8, top: 8, bottom: 8 };
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 130;
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

// --- COPY MENU (toolbar dropdown: PNG raster vs SVG vector) ---
let copyMenuEl = null;

function buildCopyMenu() {
    if (copyMenuEl) return copyMenuEl;
    copyMenuEl = document.createElement('div');
    copyMenuEl.className = 'code-menu';
    copyMenuEl.style.display = 'none';
    copyMenuEl.innerHTML =
        '<div class="code-menu-item" data-act="png">Copy as PNG</div>' +
        '<div class="code-menu-item" data-act="svg">Copy as SVG (vector)</div>';
    copyMenuEl.addEventListener('click', (e) => {
        const item = e.target.closest('.code-menu-item');
        if (!item || item.classList.contains('disabled')) { e.stopPropagation(); return; }
        e.stopPropagation();
        const act = item.getAttribute('data-act');
        hideCopyMenu();
        if (act === 'svg') copySvgToClipboard();
        else copyToClipboard();
    });
    document.body.appendChild(copyMenuEl);
    return copyMenuEl;
}

function hideCopyMenu() {
    if (copyMenuEl) copyMenuEl.style.display = 'none';
}

function toggleCopyMenu(event) {
    if (event) event.stopPropagation();
    if (currentIndex < 0 || plots.length === 0) return;
    const menu = buildCopyMenu();
    if (menu.style.display === 'block') { hideCopyMenu(); return; }

    // SVG copy only applies to a single vector plot.
    const cur = plots[currentIndex];
    const canSvg = !isSplitMode && !!cur && cur.format === 'svg';
    menu.querySelector('[data-act="svg"]').classList.toggle('disabled', !canSvg);

    menu.style.display = 'block';
    const rect = (event && event.currentTarget)
        ? event.currentTarget.getBoundingClientRect()
        : { left: 8, right: 8, top: 8, bottom: 8 };
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 80;
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

// --- SETTINGS MENU (toolbar dropdown with toggles) ---
let settingsMenuEl = null;

function buildSettingsMenu() {
    if (settingsMenuEl) return settingsMenuEl;
    settingsMenuEl = document.createElement('div');
    settingsMenuEl.className = 'code-menu';
    settingsMenuEl.style.display = 'none';
    settingsMenuEl.innerHTML =
        '<div class="code-menu-item" data-act="toggle-inspect"></div>' +
        '<div class="code-menu-sep"></div>' +
        '<div class="code-menu-item" data-act="mode-hover"></div>' +
        '<div class="code-menu-item" data-act="mode-measure"></div>' +
        '<div class="code-menu-item" data-act="mode-crop"></div>' +
        '<div class="code-menu-sep"></div>' +
        '<div class="code-menu-item" data-act="montage">Export gallery as grid (PNG)</div>' +
        '<div class="code-menu-item" data-act="present">Start presentation (P)</div>';
    settingsMenuEl.addEventListener('click', (e) => {
        const item = e.target.closest('.code-menu-item');
        if (!item || item.classList.contains('disabled')) { e.stopPropagation(); return; }
        e.stopPropagation();
        const act = item.getAttribute('data-act');
        if (act === 'toggle-inspect') {
            hoverInspectEnabled = !hoverInspectEnabled;
            vscode.setState({ ...vscode.getState(), hoverInspect: hoverInspectEnabled });
            if (!hoverInspectEnabled) { if (inspectTipEl) inspectTipEl.style.display = 'none'; clearInspectOverlay(); }
        } else if (act === 'mode-hover') setInspectMode('hover');
        else if (act === 'mode-measure') setInspectMode('measure');
        else if (act === 'mode-crop') setInspectMode('crop');
        else if (act === 'montage') { hideSettingsMenu(); exportGridMontage(); return; }
        else if (act === 'present') { startPresentation(); return; }
        updateSettingsMenu();
    });
    document.body.appendChild(settingsMenuEl);
    return settingsMenuEl;
}

function updateSettingsMenu() {
    if (!settingsMenuEl) return;
    const set = (act, text, on, disabled) => {
        const el = settingsMenuEl.querySelector('[data-act="' + act + '"]');
        if (!el) return;
        el.textContent = (on ? '✓ ' : '    ') + text;
        el.classList.toggle('disabled', !!disabled);
    };
    set('toggle-inspect', 'Hover to inspect', hoverInspectEnabled, false);
    const off = !hoverInspectEnabled;
    set('mode-hover', 'Tool: read-out + crosshair', inspectMode === 'hover', off);
    set('mode-measure', 'Tool: measure distance', inspectMode === 'measure', off);
    set('mode-crop', 'Tool: zoom to region', inspectMode === 'crop', off);
}

function hideSettingsMenu() {
    if (settingsMenuEl) settingsMenuEl.style.display = 'none';
}

function toggleSettingsMenu(event) {
    if (event) event.stopPropagation();
    const menu = buildSettingsMenu();
    if (menu.style.display === 'block') { hideSettingsMenu(); return; }
    updateSettingsMenu();
    menu.style.display = 'block';
    const rect = (event && event.currentTarget)
        ? event.currentTarget.getBoundingClientRect()
        : { left: 8, right: 8, top: 8, bottom: 8 };
    const mw = menu.offsetWidth || 190;
    const mh = menu.offsetHeight || 44;
    let left = rect.right - mw;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

// Toolbar entry point: acts on the currently selected plot.
function toggleCodeMenuToolbar(event) {
    if (event) event.stopPropagation();
    if (currentIndex < 0 || currentIndex >= plots.length) return;
    toggleCodeMenu(currentIndex, event);
}

function runCodeAction(act, index) {
    const plot = plots[index];
    if (!plot) return;
    const code = plot.code || '';
    const noCode = () => vscode.postMessage({ command: 'info', text: 'No source code captured for this plot' });
    switch (act) {
        case 'copy':
            if (!code.trim()) return noCode();
            navigator.clipboard.writeText(code).then(
                () => vscode.postMessage({ command: 'info', text: 'Code copied to clipboard' }),
                () => vscode.postMessage({ command: 'info', text: 'Copy failed: clipboard access required' })
            );
            break;
        case 'reveal':
            if (!code.trim()) return noCode();
            vscode.postMessage({ command: 'reveal_code', code });
            break;
        case 'run':
            if (!code.trim()) return noCode();
            vscode.postMessage({ command: 'run_code', code });
            break;
        case 'open':
            if (!plot.srcFile) { vscode.postMessage({ command: 'info', text: 'No source file captured for this plot' }); return; }
            vscode.postMessage({ command: 'open_source', file: plot.srcFile, line1: plot.srcLine1, line2: plot.srcLine2 });
            break;
        case 'reprex': {
            if (!code.trim()) return noCode();
            // A self-contained, shareable block: provenance header, the code, and the
            // note as a trailing comment.
            const header = plot.srcFile
                ? `# Source: ${plot.srcFile}${plot.srcLine1 ? ':' + plot.srcLine1 : ''}`
                : '# R Plot Pro reproducible snippet';
            const noteLines = plot.note ? '\n\n' + String(plot.note).split('\n').map(l => '# ' + l).join('\n') : '';
            const snippet = `${header}\n${code}${noteLines}\n`;
            navigator.clipboard.writeText(snippet).then(
                () => vscode.postMessage({ command: 'info', text: 'Reproducible snippet copied to clipboard' }),
                () => vscode.postMessage({ command: 'info', text: 'Copy failed: clipboard access required' })
            );
            break;
        }
        case 'card':
            exportPlotCard(index);
            break;
    }
}

// Render a shareable "plot card": the plot image, its generating code (monospace with
// light comment/string colouring) and any note, composited into one PNG.
async function exportPlotCard(index) {
    const plot = plots[index];
    if (!plot) return;
    try {
        const img = await new Promise<HTMLImageElement>((res, rej) => {
            const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = plot.data;
        });
        const pad = 24, gap = 16, lineH = 17, codeFont = '13px monospace';
        const cardW = 760, innerW = cardW - pad * 2;
        const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600;
        const imgW = innerW, imgH = Math.round(nh * (innerW / nw));

        const codeLines = plot.code ? wrapMonoLines(String(plot.code), innerW, codeFont) : [];
        const noteLines = plot.note ? wrapMonoLines(String(plot.note), innerW, '13px sans-serif') : [];

        let y = pad;
        const titleH = 26;
        const codeBlockH = codeLines.length ? gap + codeLines.length * lineH + 16 : 0;
        const noteH = noteLines.length ? gap + noteLines.length * lineH : 0;
        const cardH = pad + titleH + gap + imgH + codeBlockH + noteH + pad;

        const canvas = document.createElement('canvas');
        canvas.width = cardW; canvas.height = cardH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cardW, cardH);
        ctx.textBaseline = 'alphabetic';

        // Title
        ctx.fillStyle = '#111'; ctx.font = '600 15px sans-serif';
        ctx.fillText(`Plot ${index + 1}`, pad, y + 16);
        ctx.fillStyle = '#888'; ctx.font = '12px sans-serif';
        ctx.fillText(plot.timestamp || '', cardW - pad - ctx.measureText(plot.timestamp || '').width, y + 16);
        y += titleH + gap;

        // Plot image
        ctx.drawImage(img, pad, y, imgW, imgH);
        ctx.strokeStyle = '#e2e2e2'; ctx.strokeRect(pad, y, imgW, imgH);
        y += imgH;

        // Code block
        if (codeLines.length) {
            y += gap;
            ctx.fillStyle = '#f6f8fa'; ctx.fillRect(pad, y, innerW, codeLines.length * lineH + 16);
            ctx.font = codeFont;
            let cy = y + 8 + 12;
            for (const line of codeLines) { drawCodeLine(ctx, line, pad + 8, cy, codeFont); cy += lineH; }
            y += codeLines.length * lineH + 16;
        }

        // Note
        if (noteLines.length) {
            y += gap;
            ctx.fillStyle = '#444'; ctx.font = '13px sans-serif';
            for (const line of noteLines) { ctx.fillText(line, pad, y + 12); y += lineH; }
        }

        canvas.toBlob((blob) => {
            if (!blob) { vscode.postMessage({ command: 'info', text: 'Plot card export failed' }); return; }
            const reader = new FileReader();
            reader.onloadend = () => vscode.postMessage({ command: 'save_data', data: reader.result, format: 'png' });
            reader.readAsDataURL(blob);
        }, 'image/png', 0.95);
    } catch (e) {
        log('Plot card export failed: ' + e);
        vscode.postMessage({ command: 'info', text: 'Plot card export failed' });
    }
}

// Wrap text to fit a pixel width in the given canvas font (word wrap, then hard-break
// over-long tokens), preserving explicit newlines.
function wrapMonoLines(text, maxW, font) {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const out = [];
    for (const raw of text.split('\n')) {
        let line = '';
        for (const word of raw.split(/(\s+)/)) {
            if (probe.measureText(line + word).width <= maxW) { line += word; continue; }
            if (line) out.push(line);
            if (probe.measureText(word).width <= maxW) { line = word; continue; }
            let chunk = '';
            for (const ch of word) {
                if (probe.measureText(chunk + ch).width <= maxW) chunk += ch;
                else { out.push(chunk); chunk = ch; }
            }
            line = chunk;
        }
        out.push(line);
    }
    return out;
}

// Draw one line of R code with light comment/string colouring.
function drawCodeLine(ctx, line, x, y, font) {
    ctx.font = font;
    const commentAt = line.indexOf('#');
    const code = commentAt >= 0 ? line.slice(0, commentAt) : line;
    const comment = commentAt >= 0 ? line.slice(commentAt) : '';
    // String and default segments in the code part.
    const parts = code.split(/("[^"]*"|'[^']*')/);
    let cx = x;
    for (const part of parts) {
        if (!part) continue;
        ctx.fillStyle = (part[0] === '"' || part[0] === "'") ? '#0a7d33' : '#24292e';
        ctx.fillText(part, cx, y);
        cx += ctx.measureText(part).width;
    }
    if (comment) { ctx.fillStyle = '#6a737d'; ctx.fillText(comment, cx, y); }
}

// Dismiss the menu on any outside click, scroll or resize.
window.addEventListener('click', () => { hideCodeMenu(); hideCopyMenu(); hideSettingsMenu(); });
window.addEventListener('resize', () => { hideCodeMenu(); hideCopyMenu(); hideSettingsMenu(); });
document.addEventListener('scroll', () => { hideCodeMenu(); hideCopyMenu(); hideSettingsMenu(); }, true);

function toggleFavorite(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= plots.length) return;
    plots[index].isFavorite = !plots[index].isFavorite;
    vscode.setState({ ...vscode.getState(), plots: plots });
    persistMeta();
    persistArchive();
    updatePlotList();
}

function toggleFavoriteFilter() {
    showOnlyFavorites = !showOnlyFavorites;
    const btn = document.getElementById('favoriteFilterBtn');
    if (showOnlyFavorites) {
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z" /></svg>';
        btn.style.color = '#FFD700';
    } else {
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" /></svg>';
        btn.style.color = '';
    }
    updatePlotList();
}

function showNoteDialog(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= plots.length) return;
    currentNoteIndex = index;
    const textarea = document.getElementById('noteTextarea');
    textarea.value = plots[index].note || '';
    document.getElementById('noteModal').classList.add('show');
    setTimeout(() => textarea.focus(), 100);
}

function closeNoteModal() {
    document.getElementById('noteModal').classList.remove('show');
    currentNoteIndex = -1;
}

function saveNote() {
    if (currentNoteIndex < 0 || currentNoteIndex >= plots.length) return;
    plots[currentNoteIndex].note = document.getElementById('noteTextarea').value.trim();
    vscode.setState({ ...vscode.getState(), plots: plots });
    persistMeta();
    persistArchive();
    updatePlotList();
    closeNoteModal();
}

document.getElementById('noteModal').addEventListener('click', function(e) {
    if (e.target === this) closeNoteModal();
});

// Text Annotation Modal Logic
let pendingTextX = 0;
let pendingTextY = 0;

function showTextDialog() {
    const modal = document.getElementById('textModal');
    const input = document.getElementById('textInput');
    if (!modal || !input) return;
    
    input.value = '';
    modal.classList.add('show');
    // Focus after transition
    setTimeout(() => input.focus(), 100);
}

function closeTextModal() {
    document.getElementById('textModal').classList.remove('show');
}

function confirmTextAnnotation() {
    const input = document.getElementById('textInput');
    const text = input.value.trim();
    
    if (text && activeCtx) {
        activeCtx.font = "bold 20px Inter, -apple-system, sans-serif";
        activeCtx.fillStyle = currentColor;
        activeCtx.fillText(text, pendingTextX, pendingTextY);
        saveAnnotationToHistory();
    }
    closeTextModal();
}

const textInput = document.getElementById('textInput');
if (textInput) {
    textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmTextAnnotation();
        if (e.key === 'Escape') closeTextModal();
    });
}

const textModal = document.getElementById('textModal');
if (textModal) {
    textModal.addEventListener('click', function(e) {
        if (e.target === this) closeTextModal();
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); nextPlot();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); previousPlot();
    } else if (e.key === 'Escape' && isFullscreen) {
        e.preventDefault(); toggleFullscreen();
    } else if (e.key === 'D' && e.ctrlKey && e.shiftKey) {
        const logEl = document.getElementById('debugLog');
        if (logEl) logEl.style.display = logEl.style.display === 'none' ? 'block' : 'none';
    }
});

let isFullscreen = false;
function toggleFullscreen() {
    const container = document.getElementById('plotContainer');
    const img = document.getElementById('plotImage');
    const sidebar = document.querySelector('.sidebar');
    const header = document.querySelector('.header');
    
    if (!isFullscreen) {
        Object.assign(container.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', zIndex: '9999', background: 'var(--bg-primary)', padding: '20px' });
        if (img) img.style.cursor = 'zoom-out';
        if (sidebar) sidebar.style.display = 'none';
        if (header) header.style.display = 'none';
    } else {
        Object.assign(container.style, { position: '', top: '', left: '', width: '', height: '', zIndex: '', background: '', padding: '' });
        if (img) img.style.cursor = 'grab';
        if (sidebar) sidebar.style.display = '';
        if (header) header.style.display = '';
    }
    isFullscreen = !isFullscreen;
}

const plotImage = document.getElementById('plotImage');
if (plotImage) plotImage.addEventListener('dblclick', toggleFullscreen);

refreshLayout();

function saveState() {
    vscode.setState({
        ...vscode.getState(),
        currentIndex,
        isSplitMode,
        leftIndex,
        rightIndex,
        annotations: lastCanvasData.size > 0 ? Object.fromEntries(lastCanvasData) : undefined,
        plotZoom: plotZoom.size > 0 ? Object.fromEntries(plotZoom) : undefined,
        palette: paletteState
    });
}

function toggleSplitView() {
    if (plots.length < 2 && !isSplitMode) {
        vscode.postMessage({ command: 'info', text: 'You need at least two plots to use Split View.' });
        return;
    }

    isSplitMode = !isSplitMode;
    document.body.classList.toggle('is-split-mode', isSplitMode);
    const splitBtn = document.getElementById('splitBtn');
    if (splitBtn) splitBtn.classList.toggle('split-active-btn', isSplitMode);
    
    const mainWrapper = document.getElementById('mainMediaWrapper');
    const splitContainer = document.getElementById('splitViewContainer');
    
    if (isSplitMode) {
        if (mainWrapper) mainWrapper.style.display = 'none';
        if (splitContainer) splitContainer.style.display = 'flex';
        
        // Initialize split indices from history
        if (leftIndex === -1 && plots.length > 0) leftIndex = currentIndex;
        if (rightIndex === -1 && plots.length > 1) {
            rightIndex = currentIndex === 0 ? 1 : currentIndex - 1;
        }
        
        setTimeout(initSplitDivider, 50);
        focusPane('left');
        
        // Restore both
        if (leftIndex >= 0) {
            const leftUrl = plotUrls.get(plots[leftIndex].id);
            if (leftUrl) {
                document.getElementById('leftPlot').src = leftUrl;
                document.getElementById('leftMediaWrapper').style.display = 'inline-flex';
                updatePlotDimensions('leftMediaWrapper');
            }
            restoreAnnotation(plots[leftIndex].id, 'leftAnnotationCanvas');
        }
        if (rightIndex >= 0) {
            const rightUrl = plotUrls.get(plots[rightIndex].id);
            if (rightUrl) {
                document.getElementById('rightPlot').src = rightUrl;
                document.getElementById('rightMediaWrapper').style.display = 'inline-flex';
                updatePlotDimensions('rightMediaWrapper');
            }
            restoreAnnotation(plots[rightIndex].id, 'rightAnnotationCanvas');
        }
    } else {
        if (splitContainer) splitContainer.style.display = 'none';
        if (mainWrapper) {
            mainWrapper.style.display = 'inline-flex';
            updatePlotDimensions('mainMediaWrapper');
        }
        showPlot(currentIndex, true);
    }
    
    updatePlotList();
    updateControls();
    saveState();
}

function initSplitDivider() {
    const divider = document.getElementById('splitDivider');
    const leftPane = document.getElementById('leftPane');
    const container = document.getElementById('splitViewContainer');
    
    if (!divider || !container || !leftPane) return;

    divider.onmousedown = (e) => {
        isDraggingDivider = true;
        divider.classList.add('active');
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    };

    const handleMouseMove = (e) => {
        if (!isDraggingDivider) return;
        
        const containerRect = container.getBoundingClientRect();
        let percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;
        
        // Limit range to prevent panes from disappearing
        percentage = Math.max(15, Math.min(85, percentage));
        
        leftPane.style.flex = `0 0 ${percentage}%`;
        
        // Immediate UI update for plot dimensions
        updatePlotDimensions('leftMediaWrapper');
        updatePlotDimensions('rightMediaWrapper');
    };

    const handleMouseUp = () => {
        if (isDraggingDivider) {
            isDraggingDivider = false;
            divider.classList.remove('active');
            document.body.style.cursor = 'default';
            
            // Send resize events to R backend for both plots
            // Debounce or slightly delay to ensure DOM has settled
            setTimeout(() => {
                const oldActive = activePane;
                activePane = 'left';
                sendResizeEvent();
                activePane = 'right';
                sendResizeEvent();
                activePane = oldActive;
            }, 50);
        }
    };

    // Attach to window to handle dragging outside the divider
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
}

function setSplitPosition(index, side, event) {
    if (event) event.stopPropagation();
    
    if (side === 'left') {
        leftIndex = index;
    } else {
        rightIndex = index;
    }
    
    // Synchronize to this side as active
    currentIndex = index;
    activePane = side;
    
    // Refresh panes
    const plot = plots[index];
    const paneImg = document.getElementById(side === 'left' ? 'leftPlot' : 'rightPlot');
    const paneLabel = document.getElementById(side === 'left' ? 'leftPaneLabel' : 'rightPaneLabel');
    
    if (paneLabel) paneLabel.textContent = 'Plot ' + (index + 1);
    
    if (paneImg) {
        if (plotUrls.has(plot.id)) {
            paneImg.src = plotUrls.get(plot.id);
            restoreAnnotation(plot.id, side === 'left' ? 'leftAnnotationCanvas' : 'rightAnnotationCanvas');
        } else {
            broadcastToBackends({ type: 'request_binary', plot_id: plot.id });
        }
    }
    
    focusPane(side); // This will updatePlotList and updateControls
    saveState();
}

// Apply initial split mode state if restored
// initialization block removed to ensure split view starts inactive

// activePane declared at top

function focusPane(side) {
    if (!isSplitMode) return;
    activePane = side;
    
    document.querySelectorAll('.split-pane').forEach(p => p.classList.remove('focused'));
    const pane = document.getElementById(side + 'Pane');
    if (pane) pane.classList.add('focused');
    
    // Synchronize currentIndex for other features (copy, export, note)
    const newIndex = (side === 'left') ? leftIndex : rightIndex;
    if (newIndex !== -1) {
        currentIndex = newIndex;
        updateControls();
        updatePlotList(); // Show which one is "active" in the list too
    }
}

function showZoomNotification(zoomLevel) {
    const notification = document.getElementById('zoomNotification');
    if (!notification) return;
    notification.textContent = zoomLevel === 'fit' ? 'Fit' : zoomLevel + '%';
    notification.classList.add('show');
    setTimeout(() => notification.classList.remove('show'), 1500);
}

// Global state initialized at top

function toggleAnnotationMode() {
    isAnnotating = !isAnnotating;
    document.body.classList.toggle('is-annotating', isAnnotating);
    
    const annotateBtn = document.getElementById('annotateBtn');
    if (annotateBtn) annotateBtn.classList.toggle('annotate-active-btn', isAnnotating);
    
    const palette = document.getElementById('drawPalette');
    if (palette) {
        palette.style.display = isAnnotating ? 'flex' : 'none';
        if (isAnnotating) {
            applyPaletteState(true);
            initPaletteDrag();
            updatePaletteScaling();
        }
    }
    
    if (isAnnotating) {
        setupActiveCanvas();
    } else {
        // Refresh the gallery so annotation badges reflect the latest drawings.
        updatePlotList();
    }
}

let orientationSwitchTimer = null;

function togglePaletteOrientation() {
    const palette = document.getElementById('drawPalette');
    if (palette) {
        palette.classList.add('no-transition');
        palette.classList.add('is-switching');
        
        // Clear old timer if any
        if (orientationSwitchTimer) {
            clearTimeout(orientationSwitchTimer);
        }
        
        // Keep it open for 1.5s so user can re-hover
        orientationSwitchTimer = setTimeout(() => {
            palette.classList.remove('is-switching');
            orientationSwitchTimer = null;
        }, 1500);
    }
    
    paletteState.isHorizontal = !paletteState.isHorizontal;
    
    // Immediate orientation apply
    if (palette) {
        palette.classList.toggle('palette-horizontal', paletteState.isHorizontal);
    }
    
    applyPaletteState(true); // pass true to use immediate update
    
    if (palette) {
        // Double rAF to ensure browser has completely settled the instant layout
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                palette.classList.remove('no-transition');
            });
        });
    }
    saveState();
}

function applyPaletteState(immediate = false) {
    const palette = document.getElementById('drawPalette');
    if (!palette) return;
    
    palette.classList.toggle('palette-horizontal', paletteState.isHorizontal);
    
    const container = palette.parentElement;
    if (container) {
        const updatePos = () => {
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
                // Container not ready, use raw values without clamping
                palette.style.left = paletteState.x + 'px';
                palette.style.top = paletteState.y + 'px';
                return;
            }

            // Force layout reflow to ensure palette dimensions are accurate after display:flex
            const _reflow = palette.offsetHeight;
            const pRect = palette.getBoundingClientRect();

            // Calculate clamped position using high-precision rects
            const clampedX = Math.max(4, Math.min(paletteState.x, rect.width - pRect.width - 4));
            const clampedY = Math.max(4, Math.min(paletteState.y, rect.height - pRect.height - 4));
            
            palette.style.left = clampedX + 'px';
            palette.style.top = clampedY + 'px';
        };

        if (immediate) {
            updatePos();
        } else {
            requestAnimationFrame(updatePos);
        }
    } else {
        palette.style.left = paletteState.x + 'px';
        palette.style.top = paletteState.y + 'px';
    }
}

function initPaletteDrag() {
    const palette = document.getElementById('drawPalette');
    const handle = document.getElementById('paletteHandle');
    if (!palette || !handle || palette.hasDragListener) return;

    let isPaletteDragging = false;
    let offsetX, offsetY;

    handle.addEventListener('mousedown', (e) => {
        isPaletteDragging = true;
        palette.classList.add('is-dragging');
        
        const rect = palette.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        
        palette.style.opacity = '0.9';
        e.stopPropagation();
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPaletteDragging) return;
        
        const container = palette.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        
        // Calculate new position relative to the container
        let x = e.clientX - rect.left - offsetX;
        let y = e.clientY - rect.top - offsetY;
        
        // Constrain to container with small padding
        const padding = 4;
        x = Math.max(padding, Math.min(x, rect.width - palette.offsetWidth - padding));
        y = Math.max(padding, Math.min(y, rect.height - palette.offsetHeight - padding));
        
        paletteState.x = x;
        paletteState.y = y;
        palette.style.left = x + 'px';
        palette.style.top = y + 'px';
    });

    window.addEventListener('mouseup', () => {
        if (isPaletteDragging) {
            isPaletteDragging = false;
            palette.classList.remove('is-dragging');
            palette.style.opacity = '1';
            saveState();
        }
    });

    palette.hasDragListener = true;
}

// History Management
function renderState(dataUrl) {
    if (!activeCtx || !activeCanvas) return;
    activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
    if (!dataUrl) return;
    
    const img = new Image();
    img.onload = () => {
        activeCtx.drawImage(img, 0, 0, activeCanvas.width, activeCanvas.height);
    };
    img.src = dataUrl;
}

function undoAnnotation() {
    if (!isAnnotating) return;
    const pid = isSplitMode ? 
        (activePane === 'left' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
        plots[currentIndex]?.id;
    if (!pid) return;

    if (!annotationHistory.canUndo(pid)) return;

    const currentState = activeCanvas.toDataURL();
    const prevState = annotationHistory.undo(pid, currentState);
    renderState(prevState);

    // Update current storage
    lastCanvasData.set(String(pid), prevState);
    saveState();
}

function redoAnnotation() {
    if (!isAnnotating) return;
    const pid = isSplitMode ? 
        (activePane === 'left' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
        plots[currentIndex]?.id;
    if (!pid) return;

    if (!annotationHistory.canRedo(pid)) return;

    const currentState = activeCanvas.toDataURL();
    const nextState = annotationHistory.redo(pid, currentState);
    renderState(nextState);

    // Update current storage
    lastCanvasData.set(String(pid), nextState);
    saveState();
}

function updatePaletteScaling() {
    const palette = document.getElementById('drawPalette');
    const container = document.getElementById('plotContainer');
    if (!palette || !container || !isAnnotating) return;

    const scale = RPlotCore.paletteScale(container.clientWidth, container.clientHeight);
    palette.style.transform = `scale(${scale})`;
}

function setupActiveCanvas() {
    let canvasId = isSplitMode ? (activePane + 'AnnotationCanvas') : 'annotationCanvas';
    activeCanvas = document.getElementById(canvasId);
    if (activeCanvas) {
        const container = activeCanvas.parentElement;
        const newW = container.clientWidth;
        const newH = container.clientHeight;
        
        // Only reset if size changed or it was 0 (setting width/height always clears)
        if (activeCanvas.width !== newW || activeCanvas.height !== newH) {
            activeCanvas.width = newW;
            activeCanvas.height = newH;
        }

        activeCtx = activeCanvas.getContext('2d');
        
        // Restore existing drawing for this plot
        const pid = isSplitMode ? 
            (activePane === 'left' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
            plots[currentIndex]?.id;
            
        if (pid) {
            restoreAnnotation(pid, canvasId);
        }
        
        // Attach listeners if not already attached
        if (!activeCanvas.hasListener) {
            activeCanvas.addEventListener('mousedown', handleDrawStart);
            activeCanvas.addEventListener('mousemove', handleDrawMove);
            window.addEventListener('mouseup', handleDrawEnd);
            activeCanvas.hasListener = true;
        }
    }
}

function setDrawTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tool-' + tool).classList.add('active');
}

function setDrawColor(color) {
    currentColor = color;
    document.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.remove('active');
        s.style.borderColor = 'white'; // Reset to default
    });
    
    // Preset colors mapping
    const presets = {
        '#ff4757': 'color-red',
        '#2ed573': 'color-green',
        '#1e90ff': 'color-blue',
        '#ffa502': 'color-orange',
        '#ffffff': 'color-white'
    };
    
    const id = presets[color.toLowerCase()];
    if (id) {
        const swatch = document.getElementById(id);
        if (swatch) {
            swatch.classList.add('active');
            swatch.style.borderColor = color; // Match selected color
        }
        // Reset custom swatch appearance when using a preset
        const customSwatch = document.getElementById('color-custom');
        if (customSwatch) customSwatch.style.background = '#ffffff';
    } else {
        // Custom color: highlight the custom swatch and update its background/border
        const customSwatch = document.getElementById('color-custom');
        if (customSwatch) {
            customSwatch.classList.add('active');
            customSwatch.style.background = color;
            customSwatch.style.borderColor = color;
        }
    }
}

function triggerCustomColor() {
    const picker = document.getElementById('customColorPicker');
    if (picker) {
        picker.click();
    }
}

// Initialize custom color picker listener
function initCustomColorPicker() {
    const picker = document.getElementById('customColorPicker');
    if (picker) {
        picker.addEventListener('input', (e) => {
            setDrawColor(e.target.value);
        });
        picker.addEventListener('change', (e) => {
            setDrawColor(e.target.value);
            saveState();
        });
    }
}

let startImageData = null;
// Annotation drag origin (canvas coords). Declared at module scope because the draw
// handlers share it; in the old classic script these were implicit globals, which
// throw in the strict-mode bundle.
let startX = 0, startY = 0;

function handleDrawStart(e) {
    if (!isAnnotating || !activeCtx || !activeCanvas) return;
    isDrawing = true;
    const rect = activeCanvas.getBoundingClientRect();
    const p = RPlotCore.toCanvasCoords(e.clientX, e.clientY, rect, activeCanvas.width, activeCanvas.height);
    startX = p.x;
    startY = p.y;

    startImageData = activeCtx.getImageData(0, 0, activeCanvas.width, activeCanvas.height);
    
    activeCtx.beginPath();
    activeCtx.moveTo(startX, startY);
    activeCtx.strokeStyle = currentColor;
    activeCtx.fillStyle = currentColor;
    activeCtx.lineWidth = 3;
    activeCtx.lineCap = 'round';
}

function handleDrawMove(e) {
    if (!isDrawing || !activeCtx || !activeCanvas) return;
    const rect = activeCanvas.getBoundingClientRect();
    const pos = RPlotCore.toCanvasCoords(e.clientX, e.clientY, rect, activeCanvas.width, activeCanvas.height);
    const currX = pos.x;
    const currY = pos.y;

    if (currentTool === 'pencil') {
        activeCtx.lineTo(currX, currY);
        activeCtx.stroke();
    } else if (currentTool === 'arrow') {
        activeCtx.putImageData(startImageData, 0, 0);
        drawArrow(activeCtx, startX, startY, currX, currY);
    }
}

function handleDrawEnd(e) {
    if (!isDrawing) return;
    isDrawing = false;

    const rect = activeCanvas.getBoundingClientRect();
    const pos = RPlotCore.toCanvasCoords(e.clientX, e.clientY, rect, activeCanvas.width, activeCanvas.height);
    const currX = pos.x;
    const currY = pos.y;

    if (currentTool === 'text') {
        // Use custom modal instead of window.prompt (which is blocked in VS Code)
        pendingTextX = startX;
        pendingTextY = startY;
        showTextDialog();
        // Return early; saveAnnotationToHistory called after text confirmation
        return; 
    }
    
    saveAnnotationToHistory();
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
    // Vertex math lives in the typed, unit-tested core.
    const g = RPlotCore.arrowGeometry(fromX, fromY, toX, toY);

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(g.lineEndX, g.lineEndY);
    ctx.stroke();

    // Draw the sharp arrow head
    ctx.beginPath();
    ctx.moveTo(g.tipX, g.tipY); // the real tip
    ctx.lineTo(g.leftX, g.leftY);
    ctx.lineTo(g.rightX, g.rightY);
    ctx.closePath();
    ctx.fill();
}

function saveAnnotationToHistory() {
    if (!activeCanvas || plots.length === 0) return;
    const pid = isSplitMode ? 
        (activePane === 'left' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
        plots[currentIndex]?.id;
    
    if (pid) {
        // Save PREVIOUS state to the undo stack (bounded), clearing redo.
        const prevState = lastCanvasData.get(String(pid)) || '';
        annotationHistory.commit(pid, prevState);

        lastCanvasData.set(String(pid), activeCanvas.toDataURL());
        saveState(); // PERSIST TO VSCODE STATE
    }
}

function clearAnnotations() {
    if (!activeCtx || !activeCanvas) return;
    
    const pid = isSplitMode ? 
        (activePane === 'left' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
        plots[currentIndex]?.id;
    
    if (pid) {
        const prevState = lastCanvasData.get(String(pid)) || '';
        annotationHistory.commit(pid, prevState);

        activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
        lastCanvasData.delete(String(pid));
        saveState();
    }
}

function restoreAnnotation(plotId, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Always match size first
    const container = canvas.parentElement;
    if (!container) return;
    
    const w = container.clientWidth;
    const h = container.clientHeight;
    
    // Only update if dimensions actually changed or to force clear
    canvas.width = w;
    canvas.height = h;
    
    // ALWAYS clear before redrawing
    ctx.clearRect(0, 0, w, h);
    
    const data = lastCanvasData.get(String(plotId));
    if (data) {
        const img = new Image();
        canvas.pendingSource = data; // Prevent race conditions
        img.onload = () => {
            if (canvas.pendingSource === data) {
                ctx.drawImage(img, 0, 0, w, h);
                delete canvas.pendingSource;
            }
        };
        img.src = data;
    }
}

// Global resize handler for canvases
window.addEventListener('resize', () => {
    updatePaletteScaling();
    if (isSplitMode) {
        if (leftIndex >= 0) restoreAnnotation(plots[leftIndex].id, 'leftAnnotationCanvas');
        if (rightIndex >= 0) restoreAnnotation(plots[rightIndex].id, 'rightAnnotationCanvas');
    } else if (currentIndex >= 0 && plots[currentIndex]) {
        restoreAnnotation(plots[currentIndex].id, 'annotationCanvas');
    }
});

function getCombinedPlotBlob(plot, callback, opts = {}) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        const canvas = document.createElement('canvas');
        const natW = img.naturalWidth || 800;
        const natH = img.naturalHeight || 600;

        // Export sizing (scale/DPI or fixed-dimension letterbox) lives in the core.
        const { cw, ch, dx, dy, dw, dh } = RPlotCore.computeExportCanvas(natW, natH, opts);
        canvas.width = cw;
        canvas.height = ch;

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, cw, ch);

        ctx.drawImage(img, dx, dy, dw, dh);

        // Overlay annotation, aligned with the plot placement above.
        const annotationData = lastCanvasData.get(String(plot.id));
        if (annotationData) {
            const annoImg = new Image();
            annoImg.onload = () => {
                ctx.drawImage(annoImg, dx, dy, dw, dh);
                canvas.toBlob(callback, 'image/png', 0.95);
            };
            annoImg.onerror = () => {
                log('Annotation image load failed');
                canvas.toBlob(callback, 'image/png', 0.95);
            };
            annoImg.src = annotationData;
        } else {
            canvas.toBlob(callback, 'image/png', 0.95);
        }
    };
    img.onerror = () => {
        log('Base plot image load failed');
        callback(null);
    };
    img.src = plot.data;
}

async function getSplitCombinedBlob(plotL, plotR, callback, opts: any = {}) {
    const loadImg = (url): Promise<HTMLImageElement> => new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = url;
    });

    try {
        const [imgL, imgR] = await Promise.all([loadImg(plotL.data), loadImg(plotR.data)]);
        // Split view honours the preset scale (DPI multiplier); fixed-dimension
        // presets fall back to their scale or the 2x High-DPI default.
        const scale = opts.scale || 2;
        // Layout (sizes + vertically-centred draw rects) lives in the typed core.
        const layout = RPlotCore.computeSplitCanvas(
            imgL.naturalWidth, imgL.naturalHeight, imgR.naturalWidth, imgR.naturalHeight, scale);
        const { left: L, right: R } = layout;

        const canvas = document.createElement('canvas');
        canvas.width = layout.canvasW;
        canvas.height = layout.canvasH;

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw Left
        ctx.drawImage(imgL, L.x, L.y, L.w, L.h);
        const annoL = lastCanvasData.get(String(plotL.id));
        if (annoL) await drawAnno(ctx, annoL, L.x, L.y, L.w, L.h);

        // Draw Right
        ctx.drawImage(imgR, R.x, R.y, R.w, R.h);
        const annoR = lastCanvasData.get(String(plotR.id));
        if (annoR) await drawAnno(ctx, annoR, R.x, R.y, R.w, R.h);

        canvas.toBlob(callback, 'image/png', 0.95);
    } catch (e) {
        log('Split PNG generation failed: ' + e);
        callback(null);
    }
}

async function drawAnno(ctx, data, x, y, w, h) {
    return new Promise<void>((res) => {
        const img = new Image();
        img.onload = () => {
            ctx.drawImage(img, x, y, w, h);
            res();
        };
        img.onerror = () => res();
        img.src = data;
    });
}

async function generateSplitCompositeSVG(plotL, plotR) {
    try {
        const fetchBase64 = async (url) => {
            const r = await fetch(url);
            const blob = await r.blob();
            return new Promise((res) => {
                const reader = new FileReader();
                reader.onloadend = () => res(reader.result);
                reader.readAsDataURL(blob);
            });
        };

        const loadSize = (url): Promise<{ w: number; h: number }> => new Promise((res) => {
            const img = new Image();
            img.onload = () => res({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
            img.onerror = () => res({ w: 800, h: 600 });
            img.src = url;
        });

        const [dataL, dataR, sizeL, sizeR] = await Promise.all([
            fetchBase64(plotL.data),
            fetchBase64(plotR.data),
            loadSize(plotL.data),
            loadSize(plotR.data)
        ]);

        const annoL = lastCanvasData.get(String(plotL.id)) || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const annoR = lastCanvasData.get(String(plotR.id)) || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

        const totalW = sizeL.w + sizeR.w;
        const totalH = Math.max(sizeL.h, sizeR.h);

        const svg = `
<svg width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(0, ${(totalH - sizeL.h) / 2})">
        <image href="${dataL}" width="${sizeL.w}" height="${sizeL.h}" />
        <image href="${annoL}" width="${sizeL.w}" height="${sizeL.h}" />
    </g>
    <g transform="translate(${sizeL.w}, ${(totalH - sizeR.h) / 2})">
        <image href="${dataR}" width="${sizeR.w}" height="${sizeR.h}" />
        <image href="${annoR}" width="${sizeR.w}" height="${sizeR.h}" />
    </g>
</svg>`.trim();

        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    } catch (e) {
        log('Split SVG generation failed: ' + e);
        return null;
    }
}

// --- INITIALIZATION ---
const sidebarState = typeof state.sidebarHidden === 'boolean' ? state.sidebarHidden : false;
const sidebarEl = document.querySelector('.sidebar');
if (sidebarEl) {
    sidebarEl.classList.toggle('sidebar-hidden', sidebarState);
}

if (isDarkMode) {
    document.body.classList.add('dark-mode');
}
updateDarkModeUI();

// Follow VS Code theme changes until the user manually pins dark mode.
new MutationObserver(() => {
    if (darkModeUserSet) return;
    const shouldDark = detectVsCodeDark();
    if (shouldDark !== isDarkMode) {
        isDarkMode = shouldDark;
        document.body.classList.toggle('dark-mode', isDarkMode);
        updateDarkModeUI();
    }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
refreshLayout();
setDrawColor(currentColor);
initCustomColorPicker();
initHoverInspect();

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    if (presOn) {
        switch (e.key) {
            case 'Escape':     e.preventDefault(); exitPresentation(); break;
            case 'ArrowRight': case ' ': e.preventDefault(); presNav(1); break;
            case 'ArrowLeft':  e.preventDefault(); presNav(-1); break;
            case 'c': case 'C': e.preventDefault(); presShowCode = !presShowCode; renderPresentation(); break;
            case 'l': case 'L': e.preventDefault(); toggleLaserPointer(); break;
        }
        return;
    }
    if (isAnnotating) {
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                e.preventDefault();
                undoAnnotation();
            } else if (e.key === 'y' || (e.shiftKey && e.key === 'z')) {
                e.preventDefault();
                redoAnnotation();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            toggleAnnotationMode(); // leave annotation mode
        }
        return;
    }

    // Viewer shortcuts only when not typing in a field.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); previousPlot(); break;
        case 'ArrowRight': e.preventDefault(); nextPlot(); break;
        case 'a': case 'A': e.preventDefault(); toggleAnnotationMode(); break;
        case 'e': case 'E': e.preventDefault(); exportPlot(); break;
        case 'd': case 'D': e.preventDefault(); toggleDarkMode(); break;
        case 'p': case 'P': e.preventDefault(); startPresentation(); break;
        case 'l': case 'L': e.preventDefault(); toggleLaserPointer(); break;
    }
});

vscode.postMessage({ command: 'request_config' });
vscode.postMessage({ command: 'request_meta' });
vscode.postMessage({ command: 'request_archive' });
setTimeout(() => {
    document.body.style.opacity = '1';
}, 50);


// The bundle is an IIFE, so these top-level functions are not global by default.
// Inline HTML on* handlers call them by name, so expose them on window.
Object.assign(window as any, {
    clearAllPlots,
    startPresentation,
    exitPresentation,
    toggleLaserPointer,
    clearAnnotations,
    closeNoteModal,
    closeTextModal,
    confirmTextAnnotation,
    copyToClipboard,
    copySvgToClipboard,
    toggleCopyMenu,
    toggleSettingsMenu,
    openDiffView,
    closeDiffModal,
    computeDiff,
    deletePlot,
    exportPlot,
    focusPane,
    handleDragEnd,
    handleDragStart,
    nextPlot,
    openInNewWindow,
    previousPlot,
    redoAnnotation,
    saveNote,
    setDrawColor,
    setDrawTool,
    setSplitPosition,
    showNoteDialog,
    showPlot,
    toggleAnnotationMode,
    toggleAspectRatio,
    toggleCodeMenuToolbar,
    toggleDarkMode,
    toggleFavorite,
    toggleFavoriteFilter,
    togglePaletteOrientation,
    toggleSidebar,
    toggleSplitView,
    toggleZoom,
    triggerCustomColor,
    undoAnnotation
});
