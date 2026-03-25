import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
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
                    const port = plotProvider.getPort();
                    if (port) {
                        panel.webview.postMessage({ command: 'set_port', port: port });
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

            // Proactively send current port if available
            const port = plotProvider.getPort();
            if (port) {
                panel.webview.postMessage({ command: 'set_port', port: port });
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

    const uniqueConfigPath = path.join(os.tmpdir(), `${configId}.json`);
    const initRPath = path.join(context.extensionPath, 'init.R');
    const normalizedInitPath = initRPath.replace(/\\/g, '/');
    const initJlPath = path.join(context.extensionPath, 'init.jl');
    const normalizedJlPath = initJlPath.replace(/\\/g, '/');

    context.environmentVariableCollection.replace('VSCODE_R_PLOT_CONFIG', uniqueConfigPath);
    context.environmentVariableCollection.replace('VSC_R_PLOT_INIT', normalizedInitPath);
    context.environmentVariableCollection.replace('VSC_JL_PLOT_INIT', normalizedJlPath);

    plotProvider.setSessionConfigPath(uniqueConfigPath);

    const tryReadConfig = (configPath: string) => {
        try {
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(content);
                if (config.port) {
                    plotProvider.postMessage({ command: 'set_port', port: config.port });
                }
            }
        } catch (e) {
            console.error('Error reading plot config update:', e);
        }
    };

    // Initial check
    setTimeout(() => tryReadConfig(uniqueConfigPath), 500);

    // Watch the temp config file for changes (Event-driven)
    try {
        const tempDir = path.dirname(uniqueConfigPath);
        const configFilename = path.basename(uniqueConfigPath);
        
        const fsWatcher = fs.watch(tempDir, (_eventType, filename) => {
            if (filename === configFilename) {
                tryReadConfig(uniqueConfigPath);
            }
        });
        context.subscriptions.push({ dispose: () => fsWatcher.close() });
    } catch (e) {
        console.error('Failed to watch temp config dir:', e);
        // Fallback to minimal polling only if watcher fails
        const fallbackInterval = setInterval(() => tryReadConfig(uniqueConfigPath), 5000);
        context.subscriptions.push({ dispose: () => clearInterval(fallbackInterval) });
    }

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const legacyWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '.r_plot_config.json')
        );
        legacyWatcher.onDidChange(() => {
            if (!fs.existsSync(uniqueConfigPath)) {
                tryReadConfig(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.r_plot_config.json'));
            }
        });
        legacyWatcher.onDidCreate(() => {
            if (!fs.existsSync(uniqueConfigPath)) {
                tryReadConfig(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.r_plot_config.json'));
            }
        });
        context.subscriptions.push(legacyWatcher);
    }

    const config = vscode.workspace.getConfiguration('rPlotViewer');
    const autoAttach = config.get('autoAttach', true);

    if (autoAttach) {
        const rSetupCmd = `source('${normalizedInitPath}')`;
        const juliaSetupCmd = `include("${normalizedJlPath}")`;
        const injectedTerminals = new Set<vscode.Terminal>();

        const tryInject = (terminal: vscode.Terminal) => {
            if (injectedTerminals.has(terminal)) return;

            const name = terminal.name;
            // More specific check to avoid non-R terminals like "Julia REPL"
            // \bR\b ensures we match R as a standalone word, not as a character in "REPL"
            const isRTerminal = 
                name === "R Interactive" || 
                name === "R" || 
                name.startsWith("R: ") || 
                name.startsWith("R [") ||
                (/\bR\b/.test(name) && !/(Julia|Python|Node|IPython)/i.test(name) && !name.includes("zsh") && !name.includes("bash"));
            
            const isJuliaTerminal = name.toLowerCase().includes("julia");

            if (isRTerminal) {
                terminal.sendText(rSetupCmd, true);
                injectedTerminals.add(terminal);
            } else if (isJuliaTerminal) {
                terminal.sendText(juliaSetupCmd, true);
                injectedTerminals.add(terminal);
            }
        };

        if (vscode.window.activeTerminal) {
            tryInject(vscode.window.activeTerminal);
        }

        context.subscriptions.push(vscode.window.onDidOpenTerminal(term => {
            setTimeout(() => tryInject(term), 1000);
        }));

        context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.attach', () => {
            if (vscode.window.activeTerminal) {
                tryInject(vscode.window.activeTerminal);
                vscode.window.showInformationMessage('R Plot Pro attached to terminal.');
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
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath)) {
                const content = fs.readFileSync(this.sessionConfigPath, 'utf8');
                const config = JSON.parse(content);
                if (config.port) {
                    this.postMessage({ command: 'set_port', port: config.port });
                    return;
                }
            }

            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                const configPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.r_plot_config.json');
                if (fs.existsSync(configPath)) {
                    const content = fs.readFileSync(configPath, 'utf8');
                    const config = JSON.parse(content);
                    if (config.port) {
                        this.postMessage({ command: 'set_port', port: config.port });
                    }
                }
            }
        } catch (e) {
            console.error('Error reading plot config on request:', e);
        }
    }

    public getPort(): number | undefined {
        try {
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath)) {
                const content = fs.readFileSync(this.sessionConfigPath, 'utf8');
                const config = JSON.parse(content);
                return config.port;
            }
        } catch (e) {
            console.error('Error reading port:', e);
        }
        return undefined;
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
