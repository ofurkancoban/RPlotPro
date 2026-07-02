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
                    isFavorite: !!p.isFavorite
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
let isDarkMode = false; // Always start in Light Mode by default
let lastCanvasData = new Map(); // Store base64 canvas data per plot ID

// Annotation State
let isAnnotating = false;
let currentTool = 'pencil';
let currentColor = '#ff4757';
let isDrawing = false;
let activeCanvas = null;
let activeCtx = null;
let activePane = 'left';
let paletteState = state.palette || { x: 40, y: 40, isHorizontal: true };
let annotationHistory = new Map(); // Map<pid, { undo: string[], redo: string[] }>

// Rehydrate annotations if available
if (state.annotations) {
    for (const [id, data] of Object.entries(state.annotations)) {
        lastCanvasData.set(String(id), data);
    }
}

function log(msg) { 
    console.log('[R Plot]', msg); 
    logToUI(msg);
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

    let targetW, targetH;
    
    // 1. Determine Aspect Ratio numeric value
    let ratio = 0; // 0 means auto/fill behavior (no strict ratio)
    
    if (aspect === 'square') ratio = 1;
    else if (aspect === 'landscape') ratio = 4/3;
    else if (aspect === 'portrait') ratio = 3/4;
    
    // 2. Calculate "Base Fit" dimensions
    // This represents the size of the plot if Zoom was "Fit"
    let fitW, fitH;

    if (ratio === 0) {
        // Auto/Fill: Fit simply fills the container
        fitW = cw;
        fitH = ch;
    } else {
        // Aspect constrained: Find largest box of ratio that fits in cw/ch
        if (cw / ch > ratio) {
            // Container is wider than aspect -> constrain by height
            fitH = ch;
            fitW = ch * ratio;
        } else {
            // Container is taller than aspect -> constrain by width
            fitW = cw;
            fitH = cw / ratio;
        }
    }

    // 3. Apply Zoom Factor to the Base Fit dimensions
    if (zoom === 'fit') {
        targetW = fitW;
        targetH = fitH;
    } else {
        const factor = parseInt(zoom) / 100;
        targetW = fitW * factor;
        targetH = fitH * factor;
    }

    wrapper.style.width = Math.floor(targetW) + 'px';
    wrapper.style.height = Math.floor(targetH) + 'px';
    
    // 4. Centering Strategy (v0.0.49 Smart Centering)
    const fitsW = targetW <= cw;
    const fitsH = targetH <= ch;
    
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
const reconnectTimers = new Map();   // port -> timeout id (pending reconnect)
const reconnectAttempts = new Map(); // port -> consecutive failed attempts
const MAX_RECONNECT = 8;             // give up after this many tries (server truly gone)

// Cancel any pending reconnect for a port and reset its attempt counter.
function clearReconnect(port) {
    port = Number(port);
    const t = reconnectTimers.get(port);
    if (t) { clearTimeout(t); reconnectTimers.delete(port); }
    reconnectAttempts.delete(port);
}

// Schedule a reconnect to a dropped port with linear backoff (capped), unless the
// port is no longer wanted or we have exhausted the attempt budget.
function scheduleReconnect(port, lang) {
    port = Number(port);
    if (reconnectTimers.has(port)) return;             // already scheduled
    if (!desiredPorts.has(port)) return;               // no longer a live backend
    const n = (reconnectAttempts.get(port) || 0) + 1;
    // Sticky give-up: keep the counter above the budget so repeated onclose events
    // do not restart the cycle. It is reset by a successful connect (clearReconnect)
    // or by a fresh discovery calling connectToPort again.
    if (n > MAX_RECONNECT) { log(`Giving up reconnect to port ${port}`); reconnectAttempts.set(port, n); return; }
    reconnectAttempts.set(port, n);
    const delay = Math.min(1000 * n, 5000);
    log(`Reconnecting to port ${port} in ${delay}ms (attempt ${n}/${MAX_RECONNECT})`);
    const t = setTimeout(() => {
        reconnectTimers.delete(port);
        if (desiredPorts.has(port) && !activeSockets.has(port)) {
            connectToPort(port, desiredPorts.get(port) || lang);
        }
    }, delay);
    reconnectTimers.set(port, t);
}

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
            if (!socket._intentionalClose) scheduleReconnect(p, lang);
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
        log(`Failed connection to ${port}: ${e.message}`);
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
        
        const payload = new Uint8Array(buffer, 4 + metaLen);
        log(`Payload length: ${payload.byteLength} bytes`);

        // Sniff format if unknown or to verify
        let mimeType = metadata.format === 'svg' ? 'image/svg+xml' : 'image/png';
        if (payload.byteLength > 10) {
            const sniff = new TextDecoder().decode(payload.slice(0, 50));
            if (sniff.includes('<svg') || sniff.includes('<?xml')) {
                log('Sniffed format: SVG');
                mimeType = 'image/svg+xml';
            } else {
                log('Sniffed format: Likely PNG');
                mimeType = 'image/png';
            }
        }

        const blob = new Blob([payload], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        if (pid && plotUrls.has(pid)) {
            URL.revokeObjectURL(plotUrls.get(pid));
        }
        if (pid) plotUrls.set(pid, url);
        
        if (metadata.type === 'new_plot') {
            addPlot(url, metadata, port);
        } else {
            updateCurrentPlot(pid, url, port);
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
            
            // Multi-terminal stability: Replace ONLY plots from THIS port.
            // Archived plots (port === 'archive') are kept so the gallery history
            // survives an R restart; a live plot with the same id supersedes its archive.
            const otherPlots = plots.filter(p => p.port && p.port !== port);
            const taggedIncoming = incomingPlots.map(np => ({ ...np, port }));
            // IDs are "r-<timestamp>" or "jl-<timestamp>"; parseInt("r-...") = NaN
            // so strip the prefix before sorting to restore chronological order.
            const idNum = id => Number(String(id).replace(/^[a-z]+-/i, '')) || 0;
            const byId = new Map();
            for (const p of [...otherPlots, ...taggedIncoming]) {
                const prev = byId.get(String(p.id));
                if (!prev || (prev.port === 'archive' && p.port !== 'archive')) {
                    byId.set(String(p.id), p);
                }
            }
            plots = Array.from(byId.values()).sort((a,b) => idNum(a.id) - idNum(b.id));

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
        const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || (window.jsPDF);
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
                sortedLangs.forEach(lang => {
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


function addPlot(plotUrl, metadata = {}, port) {
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
        port: Number(port)
    };
    plots.push(plot);
    currentIndex = plots.length - 1;

    updatePlotList();
    showPlot(currentIndex, true);
    persistArchive();
}

function updateCurrentPlot(plotId, plotUrl, port) {
    const pid = String(plotId);
    const index = plots.findIndex(p => String(p.id) === pid);
    if (index >= 0) {
        plots[index].data = plotUrl;
        if (port) plots[index].port = Number(port);
        
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
    
    let html = '<div class="plot-item ' + isActive + ' ' + splitClass + '" id="plot-item-' + index + '" ';
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
    if (badge) badge.textContent = plots.length;

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

    document.getElementById('plotInfo').textContent = isSplitMode ? 'SPLIT' : (hasPlots ? `${currentIndex + 1} / ${plots.length}` : '');
}

function previousPlot() { if (currentIndex > 0) showPlot(currentIndex - 1); }
function nextPlot() { if (currentIndex < plots.length - 1) showPlot(currentIndex + 1); }

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
function getHistory(pid) {
    if (!annotationHistory.has(String(pid))) {
        annotationHistory.set(String(pid), { undo: [], redo: [] });
    }
    return annotationHistory.get(String(pid));
}

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

    const history = getHistory(pid);
    if (history.undo.length === 0) return;

    // Current state to redo
    const currentState = activeCanvas.toDataURL();
    history.redo.push(currentState);
    
    // Pop from undo and render
    const prevState = history.undo.pop();
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

    const history = getHistory(pid);
    if (history.redo.length === 0) return;

    // Current state back to undo
    const currentState = activeCanvas.toDataURL();
    history.undo.push(currentState);
    
    // Pop from redo and render
    const nextState = history.redo.pop();
    renderState(nextState);
    
    // Update current storage
    lastCanvasData.set(String(pid), nextState);
    saveState();
}

function updatePaletteScaling() {
    const palette = document.getElementById('drawPalette');
    const container = document.getElementById('plotContainer');
    if (!palette || !container || !isAnnotating) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    
    // Auto-scale palette if container is too small
    let scale = 1.0;
    if (cw < 400 || ch < 400) {
        scale = Math.max(0.6, Math.min(cw / 500, ch / 500));
    }
    
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

function handleDrawStart(e) {
    if (!isAnnotating || !activeCtx || !activeCanvas) return;
    isDrawing = true;
    const rect = activeCanvas.getBoundingClientRect();
    startX = (e.clientX - rect.left) * (activeCanvas.width / rect.width);
    startY = (e.clientY - rect.top) * (activeCanvas.height / rect.height);
    
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
    const currX = (e.clientX - rect.left) * (activeCanvas.width / rect.width);
    const currY = (e.clientY - rect.top) * (activeCanvas.height / rect.height);
    
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
    const currX = (e.clientX - rect.left) * (activeCanvas.width / rect.width);
    const currY = (e.clientY - rect.top) * (activeCanvas.height / rect.height);

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
    const headLength = 20;
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headAngle = Math.PI / 6; // 30 degrees offset = 60 degrees total (Equilateral)
    
    // Stop the line slightly before the tip so the head defines the sharp point
    const lineEndX = toX - 5 * Math.cos(angle);
    const lineEndY = toY - 5 * Math.sin(angle);
    
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(lineEndX, lineEndY);
    ctx.stroke();
    
    // Draw the sharp arrow head
    ctx.beginPath();
    ctx.moveTo(toX, toY); // This is the real tip
    ctx.lineTo(
        toX - headLength * Math.cos(angle - headAngle), 
        toY - headLength * Math.sin(angle - headAngle)
    );
    ctx.lineTo(
        toX - headLength * Math.cos(angle + headAngle), 
        toY - headLength * Math.sin(angle + headAngle)
    );
    ctx.closePath();
    ctx.fill();
}

function saveAnnotationToHistory() {
    if (!activeCanvas || plots.length === 0) return;
    const pid = isSplitMode ? 
        (activePane === 'left' ? plots[leftIndex]?.id : plots[rightIndex]?.id) : 
        plots[currentIndex]?.id;
    
    if (pid) {
        const history = getHistory(pid);
        // Save PREVIOUS state to undo stack before updating
        const prevState = lastCanvasData.get(String(pid)) || '';
        history.undo.push(prevState);
        // Limit history size
        if (history.undo.length > 30) history.undo.shift();
        // New action clears redo stack
        history.redo = [];

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
        const history = getHistory(pid);
        const prevState = lastCanvasData.get(String(pid)) || '';
        history.undo.push(prevState);
        history.redo = [];
        
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

        // Export presets: fixed dimensions (e.g. 1920x1080 slide) fit the plot inside
        // while keeping aspect ratio and letterboxing on white; otherwise a scale
        // factor acts as a DPI multiplier (1x screen, 2x high-DPI, 3x publication).
        let cw, ch, dx = 0, dy = 0, dw, dh;
        if (opts.width && opts.height) {
            cw = opts.width; ch = opts.height;
            const r = Math.min(cw / natW, ch / natH);
            dw = natW * r; dh = natH * r;
            dx = (cw - dw) / 2; dy = (ch - dh) / 2;
        } else {
            const scale = opts.scale || 2; // default High DPI
            cw = natW * scale; ch = natH * scale;
            dw = cw; dh = ch;
        }
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

async function getSplitCombinedBlob(plotL, plotR, callback, opts = {}) {
    const loadImg = (url) => new Promise((res, rej) => {
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
        const wL = (imgL.naturalWidth || 800) * scale;
        const hL = (imgL.naturalHeight || 600) * scale;
        const wR = (imgR.naturalWidth || 800) * scale;
        const hR = (imgR.naturalHeight || 600) * scale;

        const canvas = document.createElement('canvas');
        canvas.width = wL + wR;
        canvas.height = Math.max(hL, hR);

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw Left
        ctx.drawImage(imgL, 0, (canvas.height - hL) / 2, wL, hL);
        const annoL = lastCanvasData.get(String(plotL.id));
        if (annoL) await drawAnno(ctx, annoL, 0, (canvas.height - hL) / 2, wL, hL);

        // Draw Right
        ctx.drawImage(imgR, wL, (canvas.height - hR) / 2, wR, hR);
        const annoR = lastCanvasData.get(String(plotR.id));
        if (annoR) await drawAnno(ctx, annoR, wL, (canvas.height - hR) / 2, wR, hR);

        canvas.toBlob(callback, 'image/png', 0.95);
    } catch (e) {
        log('Split PNG generation failed: ' + e);
        callback(null);
    }
}

async function drawAnno(ctx, data, x, y, w, h) {
    return new Promise((res) => {
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

        const loadSize = (url) => new Promise((res) => {
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
refreshLayout();
setDrawColor(currentColor);
initCustomColorPicker();

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    if (isAnnotating) {
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                e.preventDefault();
                undoAnnotation();
            } else if (e.key === 'y' || (e.shiftKey && e.key === 'z')) {
                e.preventDefault();
                redoAnnotation();
            }
        }
    }
});

vscode.postMessage({ command: 'request_config' });
vscode.postMessage({ command: 'request_meta' });
vscode.postMessage({ command: 'request_archive' });
setTimeout(() => {
    document.body.style.opacity = '1';
}, 50);
