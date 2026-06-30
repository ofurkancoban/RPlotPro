import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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
    const outputChannel = vscode.window.createOutputChannel("R Plot Pro");
    outputChannel.appendLine("R Plot Pro: Extension activated.");
    
    const plotProvider = new PlotViewProvider(context.extensionUri);

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
                        panel.webview.postMessage({ command: 'set_ports', backends: backends });
                    }
                } else if (message.command === 'open_new_window') {
                    vscode.commands.executeCommand('rPlotViewer.openGallery');
                } else if (message.command === 'request_export') {
                    vscode.window.showQuickPick(['PNG', 'SVG'], { placeHolder: 'Select format to save' }).then(format => {
                        if (format) {
                            panel.webview.postMessage({ command: 'do_export', format: format.toLowerCase() });
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
                panel.webview.postMessage({ command: 'set_ports', backends: backends });
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

    plotProvider.setSessionConfigPath(uniqueConfigDir);

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

    const discoverPorts = () => {
        const backends = plotProvider.getBackends();
        if (backends.length > 0) {
            plotProvider.postMessage({ command: 'set_ports', backends });
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
                outputChannel.appendLine(`[Sentinel] Attaching to R: "${name}" | PID: ${pid}`);

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
                outputChannel.appendLine(`[Sentinel] Precise Attachment (Julia) | PID: ${pid}`);

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

        // Continuous Sentinel: Scans all terminals every 4s to catch delayed session starts (Mac/zsh)
        const sentinel = setInterval(() => {
            vscode.window.terminals.forEach(term => tryInject(term));
        }, 4000);
        context.subscriptions.push({ dispose: () => clearInterval(sentinel) });

        // Immediate triggers for better UX
        if (vscode.window.activeTerminal) tryInject(vscode.window.activeTerminal);

        context.subscriptions.push(vscode.window.onDidOpenTerminal(term => {
            setTimeout(() => tryInject(term), 2000);
        }));

        context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(term => {
            if (term) tryInject(term);
        }));

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

    constructor(
        private readonly _extensionUri: vscode.Uri,
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
                    vscode.window.showQuickPick(['PNG', 'SVG'], { placeHolder: 'Select format to save' }).then(format => {
                        if (format) {
                            this.postMessage({ command: 'do_export', format: format.toLowerCase() });
                        }
                    });
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

    private checkAndSendConfig() {
        const backends = this.getBackends();
        if (backends.length > 0) {
            this.postMessage({ command: 'set_ports', backends });
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
        
        const htmlPath = vscode.Uri.joinPath(extensionUri, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        
        // Replace placeholders
        html = html.replace(/\${webview.cspSource}/g, webview.cspSource)
                   .replace(/\${styleUri}/g, styleUri.toString())
                   .replace(/\${scriptUri}/g, scriptUri.toString());
        
        return html;
    }
}
