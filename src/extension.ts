import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type Backend = { port: number; language?: string };
type ResolvedBackend = Backend & { wsUrl: string };

// Structured logging: one output channel + a small ring buffer so the
// "Report Issue" command can attach recent activity to a prefilled GitHub issue.
let outputChannel: vscode.OutputChannel | undefined;
const LOG_BUFFER_MAX = 200;
const logBuffer: string[] = [];

function logLine(msg: string) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    outputChannel?.appendLine(line);
}

type ExportPreset = {
    label: string;
    description: string;
    format: 'png' | 'svg' | 'pdf';
    scale?: number;
    width?: number;
    height?: number;
};

// Export presets: raster presets carry a scale (DPI multiplier) or fixed
// dimensions; SVG stays vector; PDF embeds the raster at the chosen scale/size.
// Sent to the webview as { format, scale, width, height }.
const EXPORT_PRESETS: ExportPreset[] = [
    { label: 'PNG - Screen',      description: '1x, current size',     format: 'png', scale: 1 },
    { label: 'PNG - High DPI',    description: '2x resolution',        format: 'png', scale: 2 },
    { label: 'PNG - Publication', description: '3x (~300 dpi)',        format: 'png', scale: 3 },
    { label: 'PNG - Slide 16:9',  description: '1920 x 1080',          format: 'png', width: 1920, height: 1080 },
    { label: 'PDF - Publication', description: '3x (~300 dpi)',        format: 'pdf', scale: 3 },
    { label: 'PDF - Slide 16:9',  description: '1920 x 1080',          format: 'pdf', width: 1920, height: 1080 },
    { label: 'SVG - Vector',      description: 'Scalable, editable',   format: 'svg' }
];

async function pickExportPreset():
    Promise<{ format: string; scale?: number; width?: number; height?: number } | undefined> {
    const items = EXPORT_PRESETS.map(p => ({ label: p.label, description: p.description, preset: p }));
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Select export format / preset' });
    if (!chosen) return undefined;
    const p = chosen.preset;
    return { format: p.format, scale: p.scale, width: p.width, height: p.height };
}

// Resolve each backend's loopback port to a URL the webview can actually dial.
// The webview always runs in the local UI process, but with Remote-SSH, WSL,
// Dev Containers or Codespaces the R server (and its port) live on the remote
// host, so a raw ws://127.0.0.1:PORT never reaches it. asExternalUri asks VS Code
// to forward/tunnel the port and returns the address that is valid from the UI
// side; on a purely local session it returns the same loopback address.
async function resolveBackends(backends: Backend[]): Promise<ResolvedBackend[]> {
    return Promise.all(backends.map(async (b) => {
        let wsUrl = `ws://127.0.0.1:${b.port}`;
        try {
            const external = await vscode.env.asExternalUri(
                vscode.Uri.parse(`http://127.0.0.1:${b.port}`)
            );
            const scheme = external.scheme === 'https' ? 'wss' : 'ws';
            wsUrl = `${scheme}://${external.authority}`;
        } catch (_) {
            // Fall back to the loopback address (expected on local sessions).
        }
        return { ...b, wsUrl };
    }));
}

const RPROFILE_MARKER_START = '# [R Plot Pro]';
const RPROFILE_MARKER_END   = '# [R Plot Pro END]';
const RPROFILE_SNIPPET = `${RPROFILE_MARKER_START}
local({i<-Sys.getenv("RPLOT_PRO_INIT");if(nzchar(i)&&file.exists(i))source(i)})
${RPROFILE_MARKER_END}`;

function getRprofilePath(): string {
    return path.join(os.homedir(), '.Rprofile');
}

function isRprofileIntegrated(): boolean {
    const rp = getRprofilePath();
    if (!fs.existsSync(rp)) return false;
    return fs.readFileSync(rp, 'utf8').includes(RPROFILE_MARKER_START);
}

function addToRprofile(): void {
    const rp = getRprofilePath();
    const existing = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : '';
    // Avoid duplicate if somehow already there
    if (existing.includes(RPROFILE_MARKER_START)) return;
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(rp, existing + separator + '\n' + RPROFILE_SNIPPET + '\n', 'utf8');
}

function removeFromRprofile(): boolean {
    const rp = getRprofilePath();
    if (!fs.existsSync(rp)) return false;
    const content = fs.readFileSync(rp, 'utf8');
    if (!content.includes(RPROFILE_MARKER_START)) return false;
    // Remove the block including surrounding blank lines
    const cleaned = content
        .replace(new RegExp(`\\n?${RPROFILE_MARKER_START}[\\s\\S]*?${RPROFILE_MARKER_END}\\n?`, 'g'), '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
    fs.writeFileSync(rp, cleaned + '\n', 'utf8');
    return true;
}

async function setupRprofileIntegration(context: vscode.ExtensionContext): Promise<void> {
    // Already integrated — nothing to do
    if (isRprofileIntegrated()) return;

    // User previously said "Don't ask"
    if (context.globalState.get<boolean>('rprofile.declined')) return;

    const answer = await vscode.window.showInformationMessage(
        'R Plot Pro: Add a one-line hook to ~/.Rprofile so plots are captured instantly when R starts — no timing gaps, works like Positron.',
        { modal: false },
        'Add to .Rprofile',
        "Don't ask again"
    );

    if (answer === 'Add to .Rprofile') {
        try {
            addToRprofile();
            vscode.window.showInformationMessage(
                'R Plot Pro: ~/.Rprofile updated. Restart R terminals to activate instant capture.',
                'Open .Rprofile'
            ).then(btn => {
                if (btn === 'Open .Rprofile') {
                    vscode.window.showTextDocument(vscode.Uri.file(getRprofilePath()));
                }
            });
        } catch (e: any) {
            vscode.window.showErrorMessage('R Plot Pro: Could not write ~/.Rprofile — ' + e.message);
        }
    } else if (answer === "Don't ask again") {
        context.globalState.update('rprofile.declined', true);
    }
    // undefined = dismissed → ask again next time
}

export function activate(context: vscode.ExtensionContext) {
    // Create diagnostic output channel
    outputChannel = vscode.window.createOutputChannel("R Plot Pro");
    context.subscriptions.push(outputChannel);
    logLine("Extension activated.");

    const plotProvider = new PlotViewProvider(context.extensionUri, context.workspaceState);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('rPlotViewer.mainView', plotProvider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Register commands that forward actions to the webview
    context.subscriptions.push(
        vscode.commands.registerCommand('rPlotViewer.showPlot', () => {
            vscode.commands.executeCommand('rPlotViewer.mainView.focus');
        }),
        vscode.commands.registerCommand('rPlotViewer.clearPlot', () => {
            plotProvider.postMessage({ command: 'clear_plots' });
        }),
        vscode.commands.registerCommand('rPlotViewer.exportPlot', () => {
            plotProvider.postMessage({ command: 'export_plot' });
        }),
        vscode.commands.registerCommand('rPlotViewer.previousPlot', () => {
            plotProvider.postMessage({ command: 'previous_plot' });
        }),
        vscode.commands.registerCommand('rPlotViewer.nextPlot', () => {
            plotProvider.postMessage({ command: 'next_plot' });
        }),
        vscode.commands.registerCommand('rPlotViewer.openGallery', () => {
            const panel = vscode.window.createWebviewPanel(
                'rPlotGallery',
                'R Plot Gallery',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [context.extensionUri],
                    retainContextWhenHidden: true
                }
            );

            panel.webview.html = plotProvider._getHtmlForWebview(panel.webview);

            // Move to a separate floating window
            // Use minimal delay (100ms) for fast window opening while avoiding race conditions
            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(
                    () => { },
                    (err) => { console.error('Failed to move to new window:', err); }
                );
            }, 100);

            // Forward messages from panel to handle export/config same way
            panel.webview.onDidReceiveMessage(message => {
                if (message.command === 'request_config') {
                    const backends = plotProvider.getBackends();
                    if (backends.length > 0) {
                        resolveBackends(backends).then(rb =>
                            panel.webview.postMessage({ command: 'set_ports', backends: rb }));
                    }
                } else if (message.command === 'open_new_window') {
                    vscode.commands.executeCommand('rPlotViewer.openGallery');
                } else if (message.command === 'request_export') {
                    pickExportPreset().then(opts => {
                        if (opts) {
                            panel.webview.postMessage({ command: 'do_export', ...opts });
                        }
                    });
                } else if (message.command === 'save_data') {
                    vscode.window.showSaveDialog({
                        filters: { 'Images': [message.format] },
                        defaultUri: vscode.Uri.file('plot.' + message.format)
                    }).then(uri => {
                        if (uri) {
                            try {
                                const base64Data = message.data.includes(',') ? message.data.split(',')[1] : message.data;
                                fs.writeFileSync(uri.fsPath, Buffer.from(base64Data, 'base64'));
                                vscode.window.showInformationMessage(`Plot saved as ${message.format.toUpperCase()}`);
                            } catch (e: any) {
                                vscode.window.showErrorMessage('Failed to save plot: ' + e.message);
                            }
                        }
                    });
                }
            });

            // Proactively send current ports if available
            const backends = plotProvider.getBackends();
            if (backends.length > 0) {
                resolveBackends(backends).then(rb =>
                    panel.webview.postMessage({ command: 'set_ports', backends: rb }));
            }
        })
    );

    // Config logic
    const configIdKey = 'r.plot.config.id';
    let configId = context.workspaceState.get<string>(configIdKey);
    if (!configId) {
        configId = `vscode-r-plot-config-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        context.workspaceState.update(configIdKey, configId);
    }

    const uniqueConfigDir = path.join(os.tmpdir(), configId).replace(/\\/g, '/');
    if (!fs.existsSync(uniqueConfigDir)) {
        fs.mkdirSync(uniqueConfigDir, { recursive: true });
    } else {
        // Remove stale port files left by previous R sessions so getBackends()
        // starts at zero and the injection guard doesn't fire prematurely.
        try {
            for (const f of fs.readdirSync(uniqueConfigDir)) {
                if (f.endsWith('.json')) fs.unlinkSync(path.join(uniqueConfigDir, f));
            }
        } catch (_) {}
    }

    const initRPath = path.join(context.extensionPath, 'init.R');
    const normalizedInitPath = initRPath.replace(/\\/g, '/');
    const initJlPath = path.join(context.extensionPath, 'init.jl');
    const normalizedJlPath = initJlPath.replace(/\\/g, '/');

    context.environmentVariableCollection.replace('VSCODE_R_PLOT_CONFIG', uniqueConfigDir);
    context.environmentVariableCollection.replace('VSC_R_PLOT_INIT', normalizedInitPath);
    context.environmentVariableCollection.replace('VSC_JL_PLOT_INIT', normalizedJlPath);
    // Used by .Rprofile hook to source init.R at R startup (zero timing gap)
    context.environmentVariableCollection.replace('RPLOT_PRO_INIT', normalizedInitPath);

    // Configurable port range: passed to the R server so users behind strict
    // firewalls can pin the plot server to an allowed range.
    const rangeCfg = vscode.workspace.getConfiguration('rPlotViewer');
    const minPort = rangeCfg.get<number>('minPort', 10000);
    const maxPort = rangeCfg.get<number>('maxPort', 30000);
    context.environmentVariableCollection.replace('RPLOT_PORT_MIN', String(minPort));
    context.environmentVariableCollection.replace('RPLOT_PORT_MAX', String(maxPort));

    plotProvider.setSessionConfigPath(uniqueConfigDir);

    // Gallery archive lives in global storage, keyed by the workspace-stable configId
    // so it persists across sessions and R restarts.
    try {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    } catch (_) { /* best-effort */ }
    plotProvider.setArchiveFile(path.join(context.globalStorageUri.fsPath, `archive-${configId}.json`));

    // .Rprofile integration — ask user once, silently skip if already done
    setupRprofileIntegration(context);

    // Remove-from-.Rprofile command (accessible via Command Palette)
    context.subscriptions.push(
        vscode.commands.registerCommand('rPlotViewer.removeFromRprofile', () => {
            if (removeFromRprofile()) {
                vscode.window.showInformationMessage('R Plot Pro: Removed hook from ~/.Rprofile.');
                context.globalState.update('rprofile.declined', false); // re-enable future prompts
            } else {
                vscode.window.showInformationMessage('R Plot Pro: No hook found in ~/.Rprofile.');
            }
        })
    );

    // Report Issue: collect diagnostics + recent log and open a prefilled GitHub issue.
    context.subscriptions.push(
        vscode.commands.registerCommand('rPlotViewer.reportIssue', () => {
            const ext = vscode.extensions.getExtension('ofurkancoban.r-plot-pro');
            const version = ext?.packageJSON?.version ?? 'unknown';
            const backends = plotProvider.getBackends();
            const diag = [
                `- Extension version: ${version}`,
                `- VS Code version: ${vscode.version}`,
                `- Platform: ${process.platform} (${process.arch})`,
                `- Remote: ${vscode.env.remoteName ?? 'local'}`,
                `- Active backends: ${backends.length ? backends.map(b => `${b.language ?? '?'}:${b.port}`).join(', ') : 'none'}`
            ].join('\n');
            const recentLog = logBuffer.slice(-40).join('\n');
            outputChannel?.show(true);
            const body =
                `**Describe the problem**\n\n\n**Steps to reproduce**\n\n\n` +
                `**Environment**\n${diag}\n\n` +
                `**Recent log**\n\`\`\`\n${recentLog}\n\`\`\`\n`;
            const url =
                `https://github.com/ofurkancoban/RPlotPro/issues/new` +
                `?title=${encodeURIComponent('[Bug] ')}&body=${encodeURIComponent(body)}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        })
    );

    const discoverPorts = async () => {
        const backends = plotProvider.getBackends();
        if (backends.length > 0) {
            plotProvider.postMessage({ command: 'set_ports', backends: await resolveBackends(backends) });
        }
    };

    // Initial check
    setTimeout(() => discoverPorts(), 500);

    // Watch the temp config directory for changes
    try {
        const fsWatcher = fs.watch(uniqueConfigDir, (_eventType, _filename) => {
            discoverPorts();
        });
        context.subscriptions.push({ dispose: () => fsWatcher.close() });
    } catch (e) {
        console.error('Failed to watch temp config dir:', e);
        // Fallback to minimal polling
        const fallbackInterval = setInterval(() => discoverPorts(), 5000);
        context.subscriptions.push({ dispose: () => clearInterval(fallbackInterval) });
    }

    const config = vscode.workspace.getConfiguration('rPlotViewer');
    const autoAttach = config.get('autoAttach', true);

    if (autoAttach) {
        const injectedPids = new Set<number>();
        const tryInject = async (terminal: vscode.Terminal, force = false) => {
            if (!terminal) return;
            
            let pid: number | undefined;
            try {
                pid = await terminal.processId;
            } catch (e) {
                return;
            }
            if (!pid) return;

            if (!force && injectedPids.has(pid)) return;
            
            const name = terminal.name;
            const shellPath = (terminal.creationOptions as any)?.shellPath || '';
            
            // Neural Precision: Match standalone keywords using word boundaries \b (Mac support)
            const isRTerminal = /\b(r|r\.exe|rterm|r interactive)\b/i.test(name);
            const isJuliaTerminal = /\b(julia|julialauncher)\b/i.test(name);
    
            const sanitizePath = (p: string) => p.replace(/\\/g, '/');

            // Atomic R Injection
            if (isRTerminal && !injectedPids.has(pid)) {
                injectedPids.add(pid);
                logLine(`[Sentinel] Attaching to R: "${name}" | PID: ${pid}`);

                setTimeout(() => {
                    // Nano-Path: Use /tmp on Unix for shorter commands (prevents wrapping)
                    const bootDir = (os.platform() !== 'win32' && fs.existsSync('/tmp')) ? '/tmp' : os.tmpdir();
                    const rBootPath = path.join(bootDir, 'r.R');
                    const rBootContent = `Sys.setenv(VSCODE_R_PLOT_CONFIG=path.expand('${sanitizePath(uniqueConfigDir)}')); script_dir <- path.expand('${sanitizePath(path.dirname(normalizedInitPath))}'); source(file.path(script_dir, 'init.R'))`;
                    fs.writeFileSync(rBootPath, rBootContent);

                    // v0.38.0: External wipe removed (now handled internally by init.R)
                    const rCmd = `source("${sanitizePath(rBootPath)}")`;
                    terminal.sendText(rCmd, true);
                }, 1000);
            }

            // Atomic Julia Injection
            if (isJuliaTerminal && !injectedPids.has(pid)) {
                injectedPids.add(pid);
                logLine(`[Sentinel] Precise Attachment (Julia) | PID: ${pid}`);

                setTimeout(() => {
                    const bootDir = (os.platform() !== 'win32' && fs.existsSync('/tmp')) ? '/tmp' : os.tmpdir();
                    const jlBootPath = path.join(bootDir, 'j.jl');
                    const jlBootContent = `ENV["VSCODE_R_PLOT_CONFIG"]="${sanitizePath(uniqueConfigDir)}"; include("${sanitizePath(normalizedJlPath)}")`;
                    fs.writeFileSync(jlBootPath, jlBootContent);

                    // v0.38.0: External wipe removed (now handled internally by init.jl)
                    const jlCmd = `include("${sanitizePath(jlBootPath)}")`;
                    terminal.sendText(jlCmd, true);
                }, 2500);
            }
        };

        // Event-driven Sentinel: instead of polling terminals forever, we scan only
        // for a window after terminal activity. A shell may report its name as "R"
        // only once the R session actually starts, so we still need a few scans to
        // catch delayed manual starts (Mac/zsh) — but the poll auto-stops when idle,
        // dropping CPU usage to zero once everything is attached. Any terminal event
        // (open, switch, or shell-integration state change) re-opens the window, so a
        // user who types `R` long after opening a terminal is still caught.
        let sentinelTimer: NodeJS.Timeout | undefined;
        let sentinelUntil = 0;
        const kickSentinel = (windowMs = 120000) => {
            sentinelUntil = Date.now() + windowMs;
            if (sentinelTimer) return;
            sentinelTimer = setInterval(() => {
                if (Date.now() > sentinelUntil) {
                    clearInterval(sentinelTimer);
                    sentinelTimer = undefined;
                    return;
                }
                vscode.window.terminals.forEach(term => tryInject(term));
            }, 3000);
        };
        context.subscriptions.push({ dispose: () => { if (sentinelTimer) clearInterval(sentinelTimer); } });

        // Immediate triggers for better UX
        if (vscode.window.activeTerminal) tryInject(vscode.window.activeTerminal);
        kickSentinel();

        context.subscriptions.push(vscode.window.onDidOpenTerminal(term => {
            kickSentinel();
            setTimeout(() => tryInject(term), 2000);
        }));

        context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(term => {
            if (term) { tryInject(term); kickSentinel(); }
        }));

        // Shell-integration state changes fire when a command runs in a terminal
        // (e.g. the user launches R), re-opening the scan window even without a
        // terminal open/switch — this closes the "idle then start R" gap.
        if (vscode.window.onDidChangeTerminalState) {
            context.subscriptions.push(vscode.window.onDidChangeTerminalState(term => {
                if (term) { tryInject(term); kickSentinel(); }
            }));
        }

        context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.attach', () => {
            if (vscode.window.activeTerminal) {
                tryInject(vscode.window.activeTerminal, true);
                vscode.window.showInformationMessage('R Plot Pro: Force-attaching to terminal...');
            }
        }));

        vscode.commands.executeCommand('workbench.action.focusPanel');
        vscode.commands.executeCommand('rPlotViewer.mainView.focus');
    }

    // Send active R file to backend when editor changes
    const updateActiveFile = (editor: vscode.TextEditor | undefined) => {
        if (editor && editor.document.languageId === 'r') {
            const filePath = editor.document.fileName;
            plotProvider.sendActiveFile(filePath);
            // Also store in webview state for WebSocket reconnection
            plotProvider.postMessage({ 
                command: 'store_active_file', 
                filePath: filePath 
            });
        }
    };

    // Send on startup
    if (vscode.window.activeTextEditor) {
        updateActiveFile(vscode.window.activeTextEditor);
    }

    // Send whenever active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateActiveFile)
    );
}

export function deactivate() { }

class PlotViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'rPlotViewer.mainView';
    private _view?: vscode.WebviewView;
    public sessionConfigPath?: string;
    // JSON file on disk holding the gallery archive (plot images + metadata) so the
    // gallery survives an R-session shutdown or a VS Code restart.
    public archiveFile?: string;

    public setArchiveFile(p: string) {
        this.archiveFile = p;
    }

    private readArchive(): any[] {
        if (!this.archiveFile) return [];
        try {
            if (!fs.existsSync(this.archiveFile)) return [];
            const parsed = JSON.parse(fs.readFileSync(this.archiveFile, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }

    private writeArchive(plots: any[]) {
        if (!this.archiveFile) return;
        try {
            fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
            fs.writeFileSync(this.archiveFile, JSON.stringify(Array.isArray(plots) ? plots : []), 'utf8');
        } catch (_) {
            // Non-fatal: archiving is best-effort.
        }
    }

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _memento: vscode.Memento,
    ) { }

    public setSessionConfigPath(path: string) {
        this.sessionConfigPath = path;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'request_config':
                    this.checkAndSendConfig();
                    break;
                case 'open_new_window':
                    vscode.commands.executeCommand('rPlotViewer.openGallery');
                    break;
                case 'request_export':
                    pickExportPreset().then(opts => {
                        if (opts) {
                            this.postMessage({ command: 'do_export', ...opts });
                        }
                    });
                    break;
                case 'persist_meta':
                    // Persist per-plot favorites/notes to workspace storage so they
                    // survive VS Code restarts even if the webview state is dropped.
                    this._memento.update('rplot.meta', message.meta || []);
                    break;
                case 'request_meta':
                    this.postMessage({ command: 'restore_meta', meta: this._memento.get('rplot.meta', []) });
                    break;
                case 'persist_archive':
                    this.writeArchive(message.plots || []);
                    break;
                case 'request_archive':
                    this.postMessage({ command: 'restore_archive', plots: this.readArchive() });
                    break;
                case 'log':
                    logLine(`[webview] ${message.text}`);
                    break;
                case 'info':
                    logLine(`[info] ${message.text}`);
                    vscode.window.showInformationMessage(`R Plot Pro: ${message.text}`);
                    break;
                case 'save_data':
                    vscode.window.showSaveDialog({
                        filters: { 'Images': [message.format] },
                        defaultUri: vscode.Uri.file('plot.' + message.format)
                    }).then(uri => {
                        if (uri) {
                            try {
                                const base64Data = message.data.includes(',') ? message.data.split(',')[1] : message.data;
                                fs.writeFileSync(uri.fsPath, Buffer.from(base64Data, 'base64'));
                                vscode.window.showInformationMessage(`Plot saved as ${message.format.toUpperCase()}`);
                            } catch (e: any) {
                                vscode.window.showErrorMessage('Failed to save plot: ' + e.message);
                            }
                        }
                    });
                    break;
            }
        });
    }

    public getBackends(): { port: number, language?: string }[] {
        if (!this.sessionConfigPath) return [];
        try {
            if (!fs.existsSync(this.sessionConfigPath) || !fs.statSync(this.sessionConfigPath).isDirectory()) return [];
            const backends: { port: number, language?: string }[] = [];
            for (const file of fs.readdirSync(this.sessionConfigPath)) {
                if (!file.endsWith('.json')) continue;
                try {
                    const config = JSON.parse(fs.readFileSync(path.join(this.sessionConfigPath, file), 'utf8'));
                    if (config.port) backends.push({ port: config.port, language: config.language });
                } catch (e) { /* skip malformed */ }
            }
            return backends;
        } catch (e) {
            console.error('Error reading plot ports:', e);
            return [];
        }
    }

    private async checkAndSendConfig() {
        const backends = this.getBackends();
        if (backends.length > 0) {
            this.postMessage({ command: 'set_ports', backends: await resolveBackends(backends) });
        }
    }

    public postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public sendActiveFile(filePath: string) {
        this.postMessage({ 
            command: 'set_active_file', 
            filePath: filePath 
        });
    }

    public _getHtmlForWebview(webview: vscode.Webview) {
        const extensionUri = this._extensionUri;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview', 'style.css'));
        const jspdfUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview', 'vendor', 'jspdf.umd.min.js'));
        const rplotCoreUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview', 'vendor', 'rplot-core.js'));

        const htmlPath = vscode.Uri.joinPath(extensionUri, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

        // Replace placeholders
        html = html.replace(/\${webview.cspSource}/g, webview.cspSource)
                   .replace(/\${styleUri}/g, styleUri.toString())
                   .replace(/\${jspdfUri}/g, jspdfUri.toString())
                   .replace(/\${rplotCoreUri}/g, rplotCoreUri.toString())
                   .replace(/\${scriptUri}/g, scriptUri.toString());
        
        return html;
    }
}
