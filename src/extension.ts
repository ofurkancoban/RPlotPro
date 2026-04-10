import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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

    const uniqueConfigDir = path.join(os.tmpdir(), configId);
    if (!fs.existsSync(uniqueConfigDir)) {
        fs.mkdirSync(uniqueConfigDir, { recursive: true });
    }

    const initRPath = path.join(context.extensionPath, 'init.R');
    const normalizedInitPath = initRPath.replace(/\\/g, '/');
    const initJlPath = path.join(context.extensionPath, 'init.jl');
    const normalizedJlPath = initJlPath.replace(/\\/g, '/');

    context.environmentVariableCollection.replace('VSCODE_R_PLOT_CONFIG', uniqueConfigDir);
    context.environmentVariableCollection.replace('VSC_R_PLOT_INIT', normalizedInitPath);
    context.environmentVariableCollection.replace('VSC_JL_PLOT_INIT', normalizedJlPath);

    plotProvider.setSessionConfigPath(uniqueConfigDir);

    const discoverPorts = (configDir: string) => {
        try {
            if (fs.existsSync(configDir) && fs.statSync(configDir).isDirectory()) {
                const files = fs.readdirSync(configDir);
                const backends: { port: number, language?: string }[] = [];
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        try {
                            const content = fs.readFileSync(path.join(configDir, file), 'utf8');
                            const config = JSON.parse(content);
                            if (config.port) {
                                backends.push({ 
                                    port: config.port, 
                                    language: config.language 
                                });
                            }
                        } catch (e) { /* skip malformed */ }
                    }
                }
                if (backends.length > 0) {
                    plotProvider.postMessage({ command: 'set_ports', backends: backends });
                }
            }
        } catch (e) {
            console.error('Error discovering plot ports:', e);
        }
    };

    // Initial check
    setTimeout(() => discoverPorts(uniqueConfigDir), 500);

    // Watch the temp config directory for changes
    try {
        const fsWatcher = fs.watch(uniqueConfigDir, (_eventType, _filename) => {
            discoverPorts(uniqueConfigDir);
        });
        context.subscriptions.push({ dispose: () => fsWatcher.close() });
    } catch (e) {
        console.error('Failed to watch temp config dir:', e);
        // Fallback to minimal polling
        const fallbackInterval = setInterval(() => discoverPorts(uniqueConfigDir), 5000);
        context.subscriptions.push({ dispose: () => clearInterval(fallbackInterval) });
    }

    // Legacy check removed as we moved to directory-based discovery
    // and session-specific isolation.

    const config = vscode.workspace.getConfiguration('rPlotViewer');
    const autoAttach = config.get('autoAttach', true);

    if (autoAttach) {
        const rSetupCmd = `source('${normalizedInitPath}')`;
        const juliaSetupCmd = `include("${normalizedJlPath}")`;
        const injectedPids = new Set<number>();
        const tryInject = async (terminal: vscode.Terminal, retryCount = 0, force = false) => {
            if (!terminal) return;
            
            let pid: number | undefined;
            try {
                pid = await terminal.processId;
            } catch (e) {
                return;
            }
            if (!pid) return;

            if (!force && injectedPids.has(pid)) return;
            if (!force) injectedPids.add(pid);

            const name = terminal.name;
            const shellPath = (terminal.creationOptions as any)?.shellPath || '';
            
            outputChannel.appendLine(`[Scan #${retryCount}] Terminal: "${name}" | PID: ${pid} | Shell: ${shellPath}${force ? ' [FORCE]' : ''}`);

            const isRTerminal = 
                name === "R Interactive" || 
                name === "R" || 
                name.startsWith("R: ") || 
                name.startsWith("R [") ||
                name.startsWith("R (") ||
                (/\bR\b/.test(name) && !/(Julia|Python|Node|IPython)/i.test(name) && !name.includes("zsh") && !name.includes("bash"));
            
            const isJuliaTerminal = 
                /julia/i.test(name) || 
                name === "Julia REPL" ||
                name === "julia" ||
                name.startsWith("julia (");
    
            if (isRTerminal) {
                setTimeout(() => {
                    const rInner = `Sys.setenv(VSCODE_R_PLOT_CONFIG='${uniqueConfigDir}'); source(if(Sys.getenv('VSC_R_PLOT_INIT') != '') Sys.getenv('VSC_R_PLOT_INIT') else '${normalizedInitPath}')`;
                    const totalLen = 2 + rInner.length + 30; // 2 for "> ", 30 for VSC_R_PLOT_LEN prefix
                    terminal.sendText(`Sys.setenv(VSC_R_PLOT_LEN=${totalLen}); ${rInner}`, true);
                }, 3000);
            } else if (isJuliaTerminal) {
                // Wait for Julia REPL to be ready (Julia can be slow to start)
                setTimeout(() => {
                    const jlInner = `ENV["VSCODE_R_PLOT_CONFIG"] = "${uniqueConfigDir}"; include(get(ENV, "VSC_JL_PLOT_INIT", "${normalizedJlPath}"))`;
                    const totalLen = 7 + jlInner.length + 30; // 7 for "julia> ", 30 for VSC_JL_PLOT_LEN prefix
                    terminal.sendText(`ENV["VSC_JL_PLOT_LEN"] = ${totalLen}; ${jlInner}`, true);
                }, 2500);
            } else {
                // If it's a generic terminal name, it might be renamed later (VS Code behavior)
                const isGeneric = /^(zsh|bash|sh|cmd|powershell|pwsh|Task)$/i.test(name);
                if (isGeneric && retryCount < 5) {
                    const delay = retryCount === 0 ? 1500 : 3000;
                    outputChannel.appendLine(` >> Generic "${name}" detected. Retrying in ${delay}ms (Attempt ${retryCount + 1}/5)...`);
                    setTimeout(() => {
                        tryInject(terminal, retryCount + 1);
                    }, delay);
                }
            }
        };
    
        if (vscode.window.activeTerminal) {
            tryInject(vscode.window.activeTerminal);
        }
    
        context.subscriptions.push(vscode.window.onDidOpenTerminal(term => {
            outputChannel.appendLine(`New terminal opened: "${term.name}". Initial scan in 3s...`);
            setTimeout(() => tryInject(term), 3000);
        }));
    
        // Re-check terminal when focus changes, as shells often rename themselves on interaction
        context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(term => {
            if (term) {
                // We only log if it's a potential candidate to keep output clean
                const name = term.name;
                const isPotential = name === 'R Interactive' || name === 'R' || name === 'julia' || /^(zsh|bash|sh|cmd|powershell|pwsh|Task)$/i.test(name);
                if (isPotential) {
                    tryInject(term);
                }
            }
        }));
    
        context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.attach', () => {
            if (vscode.window.activeTerminal) {
                outputChannel.appendLine(`Manual attach requested for: "${vscode.window.activeTerminal.name}"`);
                tryInject(vscode.window.activeTerminal, 0, true);
                vscode.window.showInformationMessage('R Plot Pro: Force-attaching to terminal...');
            } else {
                vscode.window.showErrorMessage('No active terminal to attach to.');
            }
        }));

        // Focus the view on activation for maximum visibility
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

    private checkAndSendConfig() {
        try {
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath) && fs.statSync(this.sessionConfigPath).isDirectory()) {
                const files = fs.readdirSync(this.sessionConfigPath);
                const backends: { port: number, language?: string }[] = [];
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        try {
                            const content = fs.readFileSync(path.join(this.sessionConfigPath, file), 'utf8');
                            const config = JSON.parse(content);
                            if (config.port) {
                                backends.push({ 
                                    port: config.port, 
                                    language: config.language 
                                });
                            }
                        } catch (e) { /* skip */ }
                    }
                }
                if (backends.length > 0) {
                    this.postMessage({ command: 'set_ports', backends: backends });
                }
            }
        } catch (e) {
            console.error('Error reading plot ports on request:', e);
        }
    }

    public getBackends(): { port: number, language?: string }[] {
        try {
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath) && fs.statSync(this.sessionConfigPath).isDirectory()) {
                const files = fs.readdirSync(this.sessionConfigPath);
                const backends: { port: number, language?: string }[] = [];
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        try {
                            const content = fs.readFileSync(path.join(this.sessionConfigPath, file), 'utf8');
                            const config = JSON.parse(content);
                            if (config.port) {
                                backends.push({ 
                                    port: config.port, 
                                    language: config.language 
                                });
                            }
                        } catch (e) { /* skip */ }
                    }
                }
                return backends;
            }
        } catch (e) {
            console.error('Error reading ports:', e);
        }
        return [];
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
