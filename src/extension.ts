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
                    const sessionConfigPath = plotProvider.sessionConfigPath;
                    if (sessionConfigPath && fs.existsSync(sessionConfigPath)) {
                        const content = fs.readFileSync(sessionConfigPath, 'utf8');
                        const config = JSON.parse(content);
                        if (config.port) {
                            panel.webview.postMessage({ command: 'set_port', port: config.port });
                        }
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
                                const base64Data = message.data.replace(/^data:image\/\w+;base64,/, "");
                                fs.writeFileSync(uri.fsPath, Buffer.from(base64Data, 'base64'));
                                vscode.window.showInformationMessage(`Plot saved as ${message.format.toUpperCase()}`);
                            } catch (e: any) {
                                vscode.window.showErrorMessage('Failed to save plot: ' + e.message);
                            }
                        }
                    });
                }
            });
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

    context.environmentVariableCollection.replace('VSCODE_R_PLOT_CONFIG', uniqueConfigPath);
    context.environmentVariableCollection.replace('VSC_R_PLOT_INIT', normalizedInitPath);

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

    const pollInterval = setInterval(() => {
        if (fs.existsSync(uniqueConfigPath)) {
            tryReadConfig(uniqueConfigPath);
        }
    }, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

    setTimeout(() => tryReadConfig(uniqueConfigPath), 1000);

    try {
        const fsWatcher = fs.watch(path.dirname(uniqueConfigPath), (_eventType, filename) => {
            if (filename && path.join(path.dirname(uniqueConfigPath), filename) === uniqueConfigPath) {
                tryReadConfig(uniqueConfigPath);
            }
        });
        context.subscriptions.push({ dispose: () => fsWatcher.close() });
    } catch (e) {
        console.error('Failed to watch temp config dir:', e);
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
        const setupCmd = `source('${normalizedInitPath}')`;
        const injectedTerminals = new Set<vscode.Terminal>();

        const tryInject = (terminal: vscode.Terminal) => {
            if (injectedTerminals.has(terminal)) return;

            // Only attach to terminals that look like R terminals
            // and avoid generic shells to prevent "zsh: no matches found" errors
            if (terminal.name === "R Interactive" || terminal.name === "R" || (terminal.name.includes("R") && !terminal.name.includes("zsh") && !terminal.name.includes("bash"))) {
                terminal.sendText(setupCmd, true);
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
                                const base64Data = message.data.replace(/^data:image\/\w+;base64,/, "");
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

    public _getHtmlForWebview(_webview: vscode.Webview) {
        let port = 8765;
        try {
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath)) {
                const content = fs.readFileSync(this.sessionConfigPath, 'utf8');
                const config = JSON.parse(content);
                if (config.port) port = config.port;
            } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                const configPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.r_plot_config.json');
                if (fs.existsSync(configPath)) {
                    const content = fs.readFileSync(configPath, 'utf8');
                    const config = JSON.parse(content);
                    if (config.port) {
                        port = config.port;
                    }
                }
            }
        } catch (e) {
            console.error('Could not read r plot config:', e);
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws://localhost:* ws://127.0.0.1:*;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>R Plot Viewer</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --bg-tertiary: var(--vscode-sideBarSectionHeader-background);
            --text-primary: var(--vscode-editor-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --border-color: var(--vscode-panel-border);
            --accent: var(--vscode-focusBorder);
            --button-bg: var(--vscode-button-background);
            --button-hover: var(--vscode-button-hoverBackground);
            --list-hover: var(--vscode-list-hoverBackground);
            --list-active: var(--vscode-list-activeSelectionBackground);
            --list-active-fg: var(--vscode-list-activeSelectionForeground);
            --toolbar-hover: var(--vscode-toolbar-hoverBackground);
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background: var(--bg-primary);
            color: var(--text-primary);
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
            opacity: 0;
            transition: opacity 0.15s ease-in;
        }

        /* Top Header / Toolbar */
        .header {
            background: var(--bg-secondary); 
            padding: 0 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            flex-shrink: 0;
            height: 36px;
        }

        .title-area {
            display: none; /* Removed for more toolbar space */
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1;
        }

        .connection-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            color: var(--text-secondary);
            margin-left: 8px;
            padding-left: 8px;
            border-left: 1px solid var(--border-color);
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--vscode-debugIcon-stopForeground, #f48771);
        }
        .status-dot.connected {
            background: var(--vscode-debugIcon-startForeground, #89d185);
        }

        /* Icon Buttons */
        button.icon-btn {
            background: transparent;
            border: none;
            color: var(--text-primary);
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
        }
        
        button.icon-btn:hover:not(:disabled) {
            background: var(--toolbar-hover);
        }
        
        button.icon-btn:disabled {
            opacity: 0.3;
            cursor: default;
        }

        button.icon-btn svg {
            width: 20px;
            height: 20px;
            stroke: currentColor;
            transition: transform 0.2s ease;
        }
        
        button.icon-btn svg[fill="none"] {
            fill: none;
        }
        
        button.icon-btn svg[fill="currentColor"] {
            fill: currentColor;
            stroke: none;
        }

        /* Rotate sidebar toggle icon when in vertical layout */
        .layout-vertical #sidebarToggle svg {
            transform: rotate(90deg);
        }

        .separator {
            width: 1px;
            height: 16px;
            background: var(--border-color);
            margin: 0 4px;
        }

        /* Responsive Layout Logic */
        /* Default: Sidebar on Right (Row) */
        .main-layout {
            display: flex;
            flex-direction: row;
            height: 100vh;
            width: 100vw;
            overflow: hidden;
        }

        .sidebar-hidden {
            display: none !important;
        }

        /* Sidebar: Right side by default */
        .sidebar {
            overflow: hidden;
            width: 130px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            /* Sidebar second naturally */
        }
        
        .plot-viewer {
             /* Plot first naturally */
             flex: 1;
        }

        .plot-list {
            flex: 1;
            overflow-y: auto;
            overflow-y: overlay;
            overflow-x: hidden;
            padding: 0;
            display: flex;
            flex-direction: column; 
            align-items: center; /* Center items horizontally */
            /* gap: 4px; */
        }

        /* Vertical Layout Mod (Narrow/Square) applied via JS class */
        .layout-vertical .main-layout {
            flex-direction: column;
        }

        .layout-vertical .plot-viewer {
            flex: 1;
            height: auto; /* let flex handle it */
            min-height: 0;
        }

        .layout-vertical .sidebar {
            width: 100% !important;
            height: 105px; /* Fixed height for bottom bar - tight fit */
            border-left: none;
            border-top: 1px solid var(--border-color);
            flex-direction: row; /* Horizontal list */
        }

        /* Fix for vertical layout (bottom bar) */
        .layout-vertical .plot-item {
            width: auto;
            border-bottom: none;
            border-right: 1px solid var(--border-color);
            margin-bottom: 0;
            /* margin-right: 6px; */
        }
        
        .layout-vertical .plot-item.active {
            border-left: none;
            box-shadow: none;
            border-top: 2px solid var(--accent);
        }

        .layout-vertical .plot-list {
            flex-direction: row;
            overflow-y: hidden;
            overflow-x: auto;
            scrollbar-width: none; /* Firefox */
        }

        .layout-vertical .plot-list::-webkit-scrollbar {
            display: none; /* Chrome, Safari, Edge */
        }
        
        .layout-vertical .sidebar-header {
             /* Hide header or make strictly vertical/small in bottom mode? 
                User didn't specify, but standard is usually just list. 
                Let's keep it simply or hide it to save space. 
             */
             display: none; 
        }

        .plot-item {
            position: relative;
            width: 100%;
            padding: 2px 6px 6px 6px;
            border-bottom: 1px solid var(--border-color);
            cursor: pointer;
            opacity: 0.8;
            transition: all 0.1s;
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            align-items: center; /* Center content within item */
        }
        
        .layout-vertical .plot-item {
            border-bottom: none;
            border-right: 1px solid var(--border-color);
        }
        
        .plot-item:hover {
            background: var(--list-hover);
            opacity: 1;
        }

        .plot-item.active {
            background: var(--list-active);
            color: var(--list-active-fg);
            opacity: 1;
            box-shadow: inset 2px 0px 0 0 var(--accent);
        }
        
        .layout-vertical .plot-item.active {
            border-left: none;
            border-top: 3px solid var(--accent);
        }

        .plot-item img {
            width: 115px;
            height: 75px;
            object-fit: contain;
            border: 1px solid var(--border-color);
            margin-bottom: 4px;
            display: block;
            border-radius: 3px;
        }

        /* Thumbnail footer with two columns */
        .thumbnail-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            margin-top: 4px;
            padding: 0 4px;
        }
        
        /* Adjust footer position in bottom panel */
        .layout-vertical .thumbnail-footer {
            margin-top: -4px;
        }
        
        .plot-meta {
            font-size: 9px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            opacity: 0.8;
            gap: 2px;
        }
        
        /* Thumbnail Action Icons Container */
        .thumbnail-actions {
            display: flex;
            flex-direction: row;
            gap: 4px;
        }
        
        /* Delete Button (Thumbnails) */
        .delete-btn {
            width: 18px;
            height: 18px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: all 0.2s;
            cursor: pointer;
        }
        
        .delete-btn svg {
            width: 100%;
            height: 100%;
            fill: currentColor;
            stroke: none !important;
        }
        
        .plot-item:hover .delete-btn {
            opacity: 1;
            color: var(--vscode-errorForeground);
        }
        
        /* Favorite Star Icon */
        .favorite-btn {
            width: 18px;
            height: 18px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: all 0.2s;
            cursor: pointer;
        }
        
        .favorite-btn svg {
            width: 100%;
            height: 100%;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            transition: all 0.2s;
        }
        
        .favorite-btn.active {
            opacity: 1 !important;
            color: #FFD700;
        }
        
        .favorite-btn.active svg {
            fill: #FFD700;
            stroke: #FFD700;
        }
        
        .plot-item:hover .favorite-btn {
            opacity: 1;
        }
        
        /* Note Icon */
        .note-btn {
            width: 18px;
            height: 18px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: all 0.2s;
            cursor: pointer;
        }
        
        .note-btn svg {
            width: 100%;
            height: 100%;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
        }
        
        .note-btn.has-note {
            opacity: 1 !important;
            color: var(--vscode-charts-blue);
        }
        
        .note-btn.has-note svg {
            fill: none;
        }
        
        .plot-item:hover .note-btn {
            opacity: 1;
        }
        
        /* Modal Dialog for Notes */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }
        
        .modal-overlay.show {
            display: flex;
        }
        
        .modal-content {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 20px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }
        
        .modal-header {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--text-primary);
        }
        
        .modal-textarea {
            width: 100%;
            min-height: 100px;
            background: var(--bg-primary);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            border-radius: 3px;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            resize: vertical;
            margin-bottom: 12px;
        }
        
        .modal-textarea:focus {
            outline: 1px solid var(--accent);
        }
        
        .modal-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
        
        .modal-btn {
            padding: 6px 14px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
        }
        
        .modal-btn-primary {
            background: var(--button-bg);
            color: var(--vscode-button-foreground);
        }
        
        .modal-btn-primary:hover {
            background: var(--button-hover);
        }
        
        .modal-btn-secondary {
            background: transparent;
            color: var(--text-primary);
            border: 1px solid var(--border-color);
        }
        
        .modal-btn-secondary:hover {
            background: var(--list-hover);
        }
        
        /* Drag visual feedback */
        .plot-item.dragging {
            opacity: 0.5;
        }


        /* Right: Main Plot Area */
        .plot-viewer {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: var(--bg-primary);
            position: relative;
        }

        .plot-container {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto; 
            padding: 0; 
            background: var(--bg-primary);
            cursor: grab;
            position: relative;
        }
        
        .plot-container.dragging {
            cursor: grabbing;
            user-select: none;
        }
        
        /* Zoom level notification */
        .zoom-notification {
            position: absolute;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 18px;
            font-weight: 600;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
            z-index: 1000;
        }
        
        .zoom-notification.show {
            opacity: 1;
        }

        .plot-container img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            transition: filter 0.3s ease, transform 0.3s ease;
            transform-origin: center center;
        }
        
        .plot-container img.dark-mode {
            filter: invert(1);
        }
        
        /* Zoom levels */
        .plot-container img.zoom-fit {
            width: 100%;
            height: 100%;
            object-fit: contain;
            transform: none;
        }
        
        .plot-container img.zoom-50 {
            transform: scale(0.5);
        }
        
        .plot-container img.zoom-75 {
            transform: scale(0.75);
        }
        
        .plot-container img.zoom-100 {
            transform: scale(1);
        }
        
        .plot-container img.zoom-200 {
            transform: scale(2);
        }
        
        /* Aspect ratio modes */
        .plot-container img.aspect-auto {
            /* Default - no override */
        }
        
        .plot-container img.aspect-square {
            aspect-ratio: 1 / 1;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        
        .plot-container img.aspect-landscape {
            aspect-ratio: 4 / 3;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        
        .plot-container img.aspect-portrait {
            aspect-ratio: 3 / 4;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        
        .plot-container img.aspect-fill {
            object-fit: cover;
            width: 100%;
            height: 100%;
        }

        .empty-state {
            text-align: center;
            color: var(--text-secondary);
            opacity: 0.7;
        }
        
        .empty-state .icon { 
            font-size: 32px; 
            margin-bottom: 10px; 
            opacity: 0.5; 
        }

        /* Animated Background Styles */
        .animated-plot { width: 280px; height: 180px; margin: 0 auto 40px; position: relative; background-color: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.8)); border: 1px solid var(--vscode-widget-border, #3c3c3c); border-radius: 8px; padding: 20px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
        .plot-line { position: absolute; bottom: 20px; left: 20px; right: 20px; height: 120px; }
        .plot-line svg { width: 100%; height: 100%; }
        .plot-path { fill: none; stroke: var(--vscode-textLink-foreground, #007acc); stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 400; stroke-dashoffset: 400; animation: drawLine 3s ease-in-out infinite; }
        @keyframes drawLine { 0% { stroke-dashoffset: 400; opacity: 0.3; } 50% { stroke-dashoffset: 0; opacity: 1; } 100% { stroke-dashoffset: -400; opacity: 0.3; } }
        .plot-dots { position: absolute; width: 100%; height: 100%; top: 0; left: 0; }
        .dot { position: absolute; width: 6px; height: 6px; background-color: var(--vscode-textLink-foreground, #007acc); border-radius: 50%; animation: pulse 2s ease-in-out infinite; }
        .dot:nth-child(1) { left: 25px; bottom: 45px; animation-delay: 0s; }
        .dot:nth-child(2) { left: 65px; bottom: 65px; animation-delay: 0.3s; }
        .dot:nth-child(3) { left: 105px; bottom: 50px; animation-delay: 0.6s; }
        .dot:nth-child(4) { left: 145px; bottom: 85px; animation-delay: 0.9s; }
        .dot:nth-child(5) { left: 185px; bottom: 70px; animation-delay: 1.2s; }
        .dot:nth-child(6) { left: 225px; bottom: 95px; animation-delay: 1.5s; }
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.5); opacity: 1; box-shadow: 0 0 10px var(--vscode-textLink-foreground, #007acc); } }
        .axis { position: absolute; background-color: var(--vscode-editor-foreground, #4a4a4a); opacity: 0.2; }
        .axis-x { bottom: 20px; left: 20px; right: 20px; height: 1px; }
        .axis-y { left: 20px; bottom: 20px; top: 20px; width: 1px; }
        .impulse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: var(--vscode-textLink-foreground, #007acc); margin-left: 10px; vertical-align: middle; animation: pulse 2s ease-in-out infinite; }
    </style>
</head>
<body>
    <div class="header">
        <div class="toolbar-group">
            <div class="connection-status" style="margin-left: 0; padding-left: 0; border-left: none;">
                <span class="status-dot" id="statusDot"></span>
                <span id="statusText">...</span>
            </div>
            
            <div class="separator"></div>

            <button class="icon-btn" onclick="nextPlot()" id="nextBtn" title="Next Plot" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-arrow-big-left"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M20 15h-8v3.586a1 1 0 0 1 -1.707 .707l-6.586 -6.586a1 1 0 0 1 0 -1.414l6.586 -6.586a1 1 0 0 1 1.707 .707v3.586h8a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1z" /></svg>
            </button>
            <button class="icon-btn" onclick="previousPlot()" id="prevBtn" title="Previous Plot" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-arrow-big-right"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 9h8v-3.586a1 1 0 0 1 1.707 -.707l6.586 6.586a1 1 0 0 1 0 1.414l-6.586 6.586a1 1 0 0 1 -1.707 -.707v-3.586h-8a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1z" /></svg>
            </button>
            
            <div class="separator"></div>
            
            <button class="icon-btn" onclick="copyToClipboard()" id="copyBtn" title="Copy to Clipboard" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-copy"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" /></svg>
            </button>
            <button class="icon-btn" onclick="exportPlot()" id="exportBtn" title="Save Plot" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-device-floppy"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2" /><path d="M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M14 4l0 4l-6 0l0 -4" /></svg>
            </button> 

            <div class="separator"></div>

            <button class="icon-btn" onclick="toggleZoom()" id="zoomBtn" title="Zoom">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-zoom-pan"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M17 17l-2.5 -2.5" /><path d="M10 4l2 -2l2 2" /><path d="M20 10l2 2l-2 2" /><path d="M4 10l-2 2l2 2" /><path d="M10 20l2 2l2 -2" /></svg>
            </button>
            
            <button class="icon-btn" onclick="toggleAspectRatio()" id="aspectBtn" title="Aspect Ratio">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M17 3l4 4l-14 14l-4 -4z" /><path d="M16 7l-1.5 -1.5" /><path d="M13 10l-1.5 -1.5" /><path d="M10 13l-1.5 -1.5" /><path d="M7 16l-1.5 -1.5" /></svg>
            </button>

            <div class="separator"></div>

            <button class="icon-btn" onclick="openInNewWindow()" id="newWindowBtn" title="Open plots gallery in new window" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-window-maximize"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 16m0 1a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1z" /><path d="M4 12v-6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-6" /><path d="M12 8h4v4" /><path d="M16 8l-5 5" /></svg>
            </button>

            <div style="flex: 1"></div>

            <span style="font-size:11px; color:var(--text-secondary); min-width:30px; text-align:center; margin-right: 8px;" id="plotInfo"></span>

            <button class="icon-btn" onclick="toggleDarkMode()" id="darkModeBtn" title="Toggle Dark Mode">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /></svg>
            </button>

            <div class="separator"></div>
            
            <button class="icon-btn" onclick="toggleFavoriteFilter()" id="favoriteFilterBtn" title="Show Favorites Only" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-star"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" /></svg>
            </button>

            <button class="icon-btn" onclick="clearAllPlots()" id="clearBtn" title="Clear All" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-trash"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>
            </button>

            <button class="icon-btn" onclick="toggleSidebar()" id="sidebarToggle" title="Toggle Sidebar">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-layout-sidebar-right-collapse"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" /><path d="M15 4v16" /><path d="M9 10l2 2l-2 2" /></svg>
            </button>
        </div>
    </div>

    <div class="main-layout">
        <!-- Main Viewer (Left/Top) -->
        <div class="plot-viewer">
            <div class="plot-container" id="plotContainer">
                <div class="zoom-notification" id="zoomNotification"></div>
                <div class="zoom-notification" id="aspectNotification"></div>
                <div class="empty-state" id="emptyState" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 5; overflow: hidden;">
                    <div class="content-wrapper" style="position: absolute; top: 45%; left: 45%; transform: translate(-50%, -50%); z-index: 10; text-align: center; scale: 65%;">
                        <div class="animated-plot" style="margin-bottom: 20px;">
                            <div class="axis axis-x"></div>
                            <div class="axis axis-y"></div>
                            <div class="plot-line">
                                <svg viewBox="0 0 240 120" preserveAspectRatio="none">
                                    <path class="plot-path" d="M 0 75 Q 40 25, 80 50 T 160 30 T 240 25"></path>
                                </svg>
                            </div>
                            <div class="plot-dots">
                                <div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div>
                            </div>
                        </div>
                        <div style="text-align: center;">
                            <h3 style="margin-bottom: 5px; font-weight: 400; font-size: 24px;">No Plot<div class="impulse-dot"></div></h3>
                            <p style="font-size: 16px; opacity: 0.7;">Waiting for plot output...</p>
                        </div>
                    </div>
                </div>
                <img id="plotImage" style="display: none;" draggable="false" />
            </div>
        </div>

        <!-- Sidebar (Right/Bottom) -->
        <div class="sidebar">
            <div class="plot-list" id="plotList">
                <!-- Items injected here -->
            </div>
        </div>
    </div>
    
    <!-- Modal Dialog for Notes -->
    <div class="modal-overlay" id="noteModal">
        <div class="modal-content">
            <div class="modal-header">Plot Note</div>
            <textarea class="modal-textarea" id="noteTextarea" placeholder="Add a note for this plot..."></textarea>
            <div class="modal-actions">
                <button class="modal-btn modal-btn-secondary" onclick="closeNoteModal()">Cancel</button>
                <button class="modal-btn modal-btn-primary" onclick="saveNote()">Save</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let plots = [];
        const state = vscode.getState() || {};
        let currentIndex = typeof state.currentIndex === 'number' ? state.currentIndex : -1;
        let ws = null;
        let reconnectTimer = null;
        let currentPort = ${port};
        let resizeTimeout;
        let showOnlyFavorites = false;
        let currentNoteIndex = -1;

        function log(msg) { console.log('[R Plot]', msg); }

        // Initial layout check before anything else
        refreshLayout();
        
        // Restore opacity after short delay to allow layout to stabilize
        setTimeout(() => {
            document.body.style.opacity = '1';
        }, 50);

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'set_port':
                    if (currentPort !== message.port) {
                        currentPort = message.port;
                        connectWebSocket();
                    }
                    break;
                case 'set_active_file':
                    // Forward to R backend
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ 
                            type: 'set_active_file', 
                            filePath: message.filePath 
                        }));
                    }
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

        function connectWebSocket() {
            if (ws) {
                try { ws.close(); } catch(e) {}
                ws = null;
            }
            if (reconnectTimer) clearTimeout(reconnectTimer);

            const url = 'ws://127.0.0.1:' + currentPort;
            
            try {
                ws = new WebSocket(url);

                ws.onopen = () => {
                    log('Connected');
                    updateConnectionStatus(true);
                    ws.send(JSON.stringify({ type: 'get_plots' }));
                    
                    // Send active file info after connection established
                    if (typeof vscode !== 'undefined' && vscode.getState) {
                        const activeFile = vscode.getState()?.activeFile;
                        if (activeFile) {
                            ws.send(JSON.stringify({ 
                                type: 'set_active_file', 
                                filePath: activeFile 
                            }));
                        }
                    }
                    
                    // Initial resize after small delay to ensure layout is ready
                    setTimeout(() => { refreshLayout(); sendResizeEvent(); }, 100);
                };
                ws.onclose = () => {
                    updateConnectionStatus(false);
                    reconnectTimer = setTimeout(() => {
                         vscode.postMessage({ command: 'request_config' });
                        connectWebSocket();
                    }, 2000);
                };
                ws.onerror = (e) => {
                     updateConnectionStatus(false);
                };
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        handleMessage(data);
                    } catch (e) {}
                };
            } catch (e) {
                reconnectTimer = setTimeout(connectWebSocket, 2000);
            }
        }
        
        // Initial config check
        setTimeout(() => { vscode.postMessage({ command: 'request_config' }); }, 500);
        connectWebSocket();
        
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

        function handleMessage(data) {
            switch (data.type) {
                case 'new_plot': addPlot(data.data, data.metadata); break;
                case 'update_plot': updateCurrentPlot(data.data); break;
                case 'clear_plots': clearLocalPlots(); break;
                case 'plot_list': 
                    // Server is the source of truth for plot data
                    // We only preserve client-side metadata (notes, favorites) if IDs match
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
                    plots = serverPlots.map(serverPlot => {
                        const savedMetadata = savedMetadataMap.get(serverPlot.id);
                        return {
                            ...serverPlot,
                            note: savedMetadata?.note || '',
                            isFavorite: savedMetadata?.isFavorite || false
                        };
                    });
                    
                    rehydratePlots();
                    break;
            }
            // Also check for messages from extension (commands) which come via window message event usually?
            // Ah, this handleMessage is for WebSocket messages in existing code.
            // We need to handle extension messages separately.
            if (data.command === 'do_export') {
                exportAsFormat(data.format);
            }
        }

        // Listener for extension messages
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'do_export') {
                exportAsFormat(message.format);
            }
        });

        // ... existing code ...

        function exportAsFormat(format) {
            if (currentIndex < 0) return;
            const plot = plots[currentIndex];
            const isSvgSource = plot.data.startsWith('data:image/svg+xml');

            if (format === 'svg') {
                if (isSvgSource) {
                    vscode.postMessage({ command: 'save_data', data: plot.data, format: 'svg' });
                } else {
                    // Fallback or error? Raster to SVG is pointless, just save as is?
                    // User explicitly asked for SVG layout.
                    // But we can't make raster vector.
                    vscode.postMessage({ command: 'save_data', data: plot.data, format: 'png' }); // cheat?
                }
            } else if (format === 'png') {
                if (isSvgSource) {
                    // Convert to PNG
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.naturalWidth || 800; // Fallback
                        canvas.height = img.naturalHeight || 600;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = "white"; 
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                        const pngData = canvas.toDataURL('image/png');
                        vscode.postMessage({ command: 'save_data', data: pngData, format: 'png' });
                    };
                    img.src = plot.data;
                } else {
                    // Already png
                     vscode.postMessage({ command: 'save_data', data: plot.data, format: 'png' });
                }
            }
        }

        function rehydratePlots() {
             updatePlotList(); 
             
             // Handle sidebar state
             if (state.sidebarHidden) {
                 document.querySelector('.sidebar').classList.add('sidebar-hidden');
             }
             
             // Restore dark mode state
             if (state.darkMode) {
                 const plotImage = document.getElementById('plotImage');
                 const darkModeBtn = document.getElementById('darkModeBtn');
                 plotImage.classList.add('dark-mode');
                 darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 3.34a10 10 0 1 1 -4.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 4.995 -8.336z" /></svg>';
             }

             // Restore zoom state
             if (state.zoomLevel) {
                 const plotImage = document.getElementById('plotImage');
                 const zoomBtn = document.getElementById('zoomBtn');
                 plotImage.classList.add('zoom-' + state.zoomLevel);
                 if (state.zoomLevel !== 'fit') {
                     zoomBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-zoom-pan"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M12 8a4 4 0 0 1 3.447 6.031l2.26 2.262a1 1 0 0 1 -1.414 1.414l-2.262 -2.26a4 4 0 0 1 -6.031 -3.447l.005 -.2a4 4 0 0 1 3.995 -3.8" /\u003e\u003cpath d="M11.293 1.293a1 1 0 0 1 1.414 0l2 2a1 1 0 1 1 -1.414 1.414l-1.293 -1.292l-1.293 1.292a1 1 0 0 1 -1.32 .083l-.094 -.083a1 1 0 0 1 0 -1.414z" /\u003e\u003cpath d="M19.293 9.293a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 -1.414l1.292 -1.293l-1.292 -1.293a1 1 0 0 1 -.083 -1.32z" /\u003e\u003cpath d="M3.293 9.293a1 1 0 1 1 1.414 1.414l-1.292 1.293l1.292 1.293a1 1 0 0 1 .083 1.32l-.083 .094a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414z" /\u003e\u003cpath d="M9.293 19.293a1 1 0 0 1 1.414 0l1.293 1.292l1.294 -1.292a1 1 0 0 1 1.32 -.083l.094 .083a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414" /\u003e\u003c/svg\u003e';
                 }
             }
             
             // Restore aspect ratio state
             if (state.aspectRatio) {
                 const plotImage = document.getElementById('plotImage');
                 const aspectBtn = document.getElementById('aspectBtn');
                 plotImage.classList.add('aspect-' + state.aspectRatio);
                 if (state.aspectRatio !== 'auto') {
                     aspectBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2-off"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12.03 7.97l4.97 -4.97l4 4l-5 5m-2 2l-7 7l-4 -4l7 -7" /><path d="M16 7l-1.5 -1.5" /><path d="M13 10l-1.5 -1.5" /><path d="M10 13l-1.5 -1.5" /><path d="M7 16l-1.5 -1.5" /><path d="M3 3l18 18" /></svg>';
                 }
             }

             // Logic to keeping active plot valid
             if (plots.length === 0) {
                 clearLocalPlots();
             } else {
                 // Check if currentIndex is still valid, if not clamp it
                 if (currentIndex >= plots.length) currentIndex = plots.length - 1;
                 if (currentIndex < 0) currentIndex = 0;
                 showPlot(currentIndex);
             }
        }

        function updateConnectionStatus(connected) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            if (connected) {
                dot.classList.add('connected');
                text.textContent = 'Active';
            } else {
                dot.classList.remove('connected');
                text.textContent = 'Offline';
            }
        }


        function addPlot(plotData, metadata = {}) {
            const plot = {
                id: metadata.id || Date.now(),
                data: plotData,
                timestamp: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}),
                note: metadata.note || '',
                isFavorite: metadata.isFavorite || false
            };
            plots.push(plot);
            currentIndex = plots.length - 1;

            // Optimally add to list without rebuilding
            if (!showOnlyFavorites || plot.isFavorite) {
                const listEl = document.getElementById('plotList');
                if (listEl) {
                    // Check if showing empty state
                    if (listEl.children.length === 1 && listEl.children[0].textContent.includes('No ')) {
                        listEl.innerHTML = '';
                    }

                    const html = createPlotItemHTML(plot, currentIndex);
                    listEl.insertAdjacentHTML('afterbegin', html);
                    
                    const badge = document.getElementById('countBadge');
                    if (badge) badge.textContent = plots.length;
                }
            } else if (!showOnlyFavorites) {
                // Should catch case where list was empty/no history
                 updatePlotList();
            }

            showPlot(currentIndex);
        }

        function updateCurrentPlot(plotData) {
            if (currentIndex >= 0 && currentIndex < plots.length) {
                plots[currentIndex].data = plotData;
                const plotImage = document.getElementById('plotImage');
                if (plotImage) plotImage.src = plotData;
                
                // Update thumbnail efficiently
                const thumbItem = document.getElementById('plot-item-' + currentIndex);
                if (thumbItem) {
                    const img = thumbItem.querySelector('img');
                    if (img) img.src = plotData;
                }
            }
        }
        
        function clearLocalPlots() {
            plots = [];
            currentIndex = -1;
            vscode.setState({ currentIndex: -1 });
            document.getElementById('plotImage').style.display = 'none';
            document.getElementById('emptyState').style.display = 'block';
            updatePlotList();
            updateControls();
        }
        
        // Delete Handler
        function deletePlot(index, event) {
            if (event) event.stopPropagation();
            if (index < 0 || index >= plots.length) return;
            
            const pid = plots[index].id;
            // Optimistic UI update? No, safer to wait for server sync
            // But we can hide it?
            // Actually server responds fast with 'plot_list', let's just send request
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'delete_plot', plot_id: pid }));
            }
        }

        function createPlotItemHTML(plot, index) {
            const isActive = index === currentIndex ? 'active' : '';
            const favoriteClass = plot.isFavorite ? 'active' : '';
            const noteClass = plot.note ? 'has-note' : '';
            const favoriteTitle = plot.isFavorite ? 'Remove from favorites' : 'Add to favorites';
            const noteTitle = plot.note ? 'Edit note' : 'Add note';
            
            let html = '<div class="plot-item ' + isActive + '" id="plot-item-' + index + '" ';
            html += 'onclick="showPlot(' + index + ')" ';
            html += 'draggable="true" ';
            html += 'ondragstart="handleDragStart(event, ' + index + ')" ';
            html += 'ondragend="handleDragEnd(event)">';
            html += '<img src="' + plot.data + '" loading="lazy" alt="Plot ' + (index + 1) + '"/>';
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
            
            const badge = document.getElementById('countBadge');
            if (badge) badge.textContent = plots.length;

            if (plots.length === 0) {
                listEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;opacity:0.5; font-style: italic;">No history</div>';
                return;
            }
            
            // Filter plots if favorite filter is active
            const displayPlots = showOnlyFavorites ? plots.filter(p => p.isFavorite) : plots;
            
            if (displayPlots.length === 0 && showOnlyFavorites) {
                listEl.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;opacity:0.5; font-style: italic;">No favorites</div>';
                return;
            }
            
            // Reverse order for history (newest top)
            listEl.innerHTML = displayPlots.map(plot => {
                const actualIndex = plots.indexOf(plot);
                return createPlotItemHTML(plot, actualIndex);
            }).reverse().join('');
        }


        function showPlot(index) {
            if (index < 0 || index >= plots.length) return;
            currentIndex = index;
            
            const currentState = vscode.getState() || {};
            vscode.setState({ ...currentState, currentIndex: index }); // Save state
            
            const plot = plots[index];
            const plotImage = document.getElementById('plotImage');
            
            plotImage.src = plot.data;
            plotImage.style.display = 'block';
            document.getElementById('emptyState').style.display = 'none';
            
            // Restore dark mode state if it was enabled
            if (currentState.darkMode) {
                plotImage.classList.add('dark-mode');
            }
            
            // Restore zoom state if it was set
            if (currentState.zoomLevel) {
                plotImage.classList.add('zoom-' + currentState.zoomLevel);
            }
            
            // Restore aspect ratio state if it was set
            if (currentState.aspectRatio) {
                plotImage.classList.add('aspect-' + currentState.aspectRatio);
            }
            
            updateControls();
            
            // Update active state without rebuilding list to allow transitions and prevent flicker
            document.querySelectorAll('.plot-item.active').forEach(el => el.classList.remove('active'));
            const activeItem = document.getElementById('plot-item-' + index);
            if (activeItem) {
                activeItem.classList.add('active');
                // Ensure active item is visible
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            
            // Trigger a resize to ensure it fits (debounce handled inside)
            sendResizeEvent();
        }

        function toggleSidebar() {
            const sidebar = document.querySelector('.sidebar');
            const isHidden = sidebar.classList.toggle('sidebar-hidden');
            
            const currentState = vscode.getState() || {};
            vscode.setState({ ...currentState, sidebarHidden: isHidden });
            
            // Refresh plot layout
            sendResizeEvent();
        }
        function openInNewWindow() {
             vscode.postMessage({ command: 'open_new_window' });
        }
        
        function toggleDarkMode() {
            const plotImage = document.getElementById('plotImage');
            const darkModeBtn = document.getElementById('darkModeBtn');
            const isDarkMode = plotImage.classList.toggle('dark-mode');
            
            // Update button icon
            if (isDarkMode) {
                darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 3.34a10 10 0 1 1 -4.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 4.995 -8.336z" /></svg>';
            } else {
                darkModeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-circle"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /></svg>';
            }
            
            // Save state
            const currentState = vscode.getState() || {};
            vscode.setState({ ...currentState, darkMode: isDarkMode });
        }
        
        function toggleZoom() {
            const plotImage = document.getElementById('plotImage');
            const zoomBtn = document.getElementById('zoomBtn');
            const currentState = vscode.getState() || {};
            
            // Define zoom cycle: fit -> 50 -> 75 -> 100 -> 200 -> fit (repeat)
            const zoomLevels = ['fit', 50, 75, 100, 200];
            let currentZoom = currentState.zoomLevel || 'fit';
            let currentIndex = zoomLevels.indexOf(currentZoom);
            
            // If current zoom not in array, start from beginning
            if (currentIndex === -1) currentIndex = 0;
            
            // Move to next zoom level
            currentIndex = (currentIndex + 1) % zoomLevels.length;
            const newZoom = zoomLevels[currentIndex];
            
            // Remove all zoom classes
            plotImage.classList.remove('zoom-fit', 'zoom-50', 'zoom-75', 'zoom-100', 'zoom-200');
            
            // Add new zoom class
            plotImage.classList.add('zoom-' + newZoom);
            
            // Update button icon (outline at fit, filled at others)
            if (newZoom === 'fit') {
                // At fit, use outline icon
                zoomBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-zoom-pan"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /\u003e\u003cpath d="M17 17l-2.5 -2.5" /\u003e\u003cpath d="M10 4l2 -2l2 2" /\u003e\u003cpath d="M20 10l2 2l-2 2" /\u003e\u003cpath d="M4 10l-2 2l2 2" /\u003e\u003cpath d="M10 20l2 2l2 -2" /\u003e\u003c/svg\u003e';
            } else {
                // At zoom levels, use filled icon
                zoomBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-zoom-pan"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M12 8a4 4 0 0 1 3.447 6.031l2.26 2.262a1 1 0 0 1 -1.414 1.414l-2.262 -2.26a4 4 0 0 1 -6.031 -3.447l.005 -.2a4 4 0 0 1 3.995 -3.8" /\u003e\u003cpath d="M11.293 1.293a1 1 0 0 1 1.414 0l2 2a1 1 0 1 1 -1.414 1.414l-1.293 -1.292l-1.293 1.292a1 1 0 0 1 -1.32 .083l-.094 -.083a1 1 0 0 1 0 -1.414z" /\u003e\u003cpath d="M19.293 9.293a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 -1.414l1.292 -1.293l-1.292 -1.293a1 1 0 0 1 -.083 -1.32z" /\u003e\u003cpath d="M3.293 9.293a1 1 0 1 1 1.414 1.414l-1.292 1.293l1.292 1.293a1 1 0 0 1 .083 1.32l-.083 .094a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414z" /\u003e\u003cpath d="M9.293 19.293a1 1 0 0 1 1.414 0l1.293 1.292l1.294 -1.292a1 1 0 0 1 1.32 -.083l.094 .083a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1 -1.414 0l-2 -2a1 1 0 0 1 0 -1.414" /\u003e\u003c/svg\u003e';
            }
            
            // Show zoom notification
            showZoomNotification(newZoom);
            
            // Save state
            vscode.setState({ ...currentState, zoomLevel: newZoom });
        }
        
        function showZoomNotification(zoomLevel) {
            const notification = document.getElementById('zoomNotification');
            if (!notification) return;
            
            // Format zoom level text
            let zoomText = zoomLevel === 'fit' ? 'Fit' : zoomLevel + '%';
            notification.textContent = zoomText;
            
            // Show notification
            notification.classList.add('show');
            
            // Hide after 1.5 seconds
            setTimeout(() => {
                notification.classList.remove('show');
            }, 1500);
        }
        
        function toggleAspectRatio() {
            const plotImage = document.getElementById('plotImage');
            const aspectBtn = document.getElementById('aspectBtn');
            const currentState = vscode.getState() || {};
            
            // Define aspect ratio cycle: auto -> square -> landscape -> portrait -> fill -> auto (repeat)
            const aspectRatios = ['auto', 'square', 'landscape', 'portrait', 'fill'];
            let currentAspect = currentState.aspectRatio || 'auto';
            let currentIndex = aspectRatios.indexOf(currentAspect);
            
            // If current aspect not in array, start from beginning
            if (currentIndex === -1) currentIndex = 0;
            
            // Move to next aspect ratio
            currentIndex = (currentIndex + 1) % aspectRatios.length;
            const newAspect = aspectRatios[currentIndex];
            
            // Remove all aspect ratio classes
            plotImage.classList.remove('aspect-auto', 'aspect-square', 'aspect-landscape', 'aspect-portrait', 'aspect-fill');
            
            // Add new aspect ratio class
            plotImage.classList.add('aspect-' + newAspect);
            
            // Update button icon (outline at auto, filled at others)
            if (newAspect === 'auto') {
                // At auto, use outline icon
                aspectBtn.innerHTML = '\u003csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2"\u003e\u003cpath stroke="none" d="M0 0h24v24H0z" fill="none"/\u003e\u003cpath d="M17 3l4 4l-14 14l-4 -4z" /\u003e\u003cpath d="M16 7l-1.5 -1.5" /\u003e\u003cpath d="M13 10l-1.5 -1.5" /\u003e\u003cpath d="M10 13l-1.5 -1.5" /\u003e\u003cpath d="M7 16l-1.5 -1.5" /\u003e\u003c/svg\u003e';
            } else {
                // At other modes, use ruler-2-off icon
                aspectBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-ruler-2-off"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12.03 7.97l4.97 -4.97l4 4l-5 5m-2 2l-7 7l-4 -4l7 -7" /><path d="M16 7l-1.5 -1.5" /><path d="M10 13l-1.5 -1.5" /><path d="M7 16l-1.5 -1.5" /><path d="M3 3l18 18" /></svg>';
            }
            
            // Show aspect ratio notification
            showAspectNotification(newAspect);
            
            // Save state
            vscode.setState({ ...currentState, aspectRatio: newAspect });
            
            // Trigger resize to redraw plot with new aspect ratio
            setTimeout(() => sendResizeEvent(), 100);
        }
        
        function showAspectNotification(aspectRatio) {
            const notification = document.getElementById('aspectNotification');
            if (!notification) return;
            
            // Format aspect ratio text
            let aspectText = aspectRatio.charAt(0).toUpperCase() + aspectRatio.slice(1);
            notification.textContent = aspectText;
            
            // Show notification
            notification.classList.add('show');
            
            // Hide after 1.5 seconds
            setTimeout(() => {
                notification.classList.remove('show');
            }, 1500);
        }

        function updateControls() {
            const hasPlots = plots.length > 0;
            document.getElementById('prevBtn').disabled = !hasPlots || currentIndex === 0;
            document.getElementById('nextBtn').disabled = !hasPlots || currentIndex === plots.length - 1;
            document.getElementById('exportBtn').disabled = !hasPlots;
            document.getElementById('copyBtn').disabled = !hasPlots;
            document.getElementById('newWindowBtn').disabled = !hasPlots;
            document.getElementById('clearBtn').disabled = !hasPlots;
            document.getElementById('zoomBtn').disabled = !hasPlots;
            document.getElementById('aspectBtn').disabled = !hasPlots;
            document.getElementById('darkModeBtn').disabled = !hasPlots;
            document.getElementById('favoriteFilterBtn').disabled = !hasPlots;
            
            document.getElementById('plotInfo').textContent = hasPlots ? \`\${currentIndex + 1} / \${plots.length}\` : '';
        }


        function previousPlot() { if (currentIndex > 0) showPlot(currentIndex - 1); }
        function nextPlot() { if (currentIndex < plots.length - 1) showPlot(currentIndex + 1); }

        function clearAllPlots() {
             if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'clear_all' }));
             clearLocalPlots();
        }

        function exportPlot() {
            if (currentIndex < 0) return;
            vscode.postMessage({ command: 'request_export' });
        }

        function copyToClipboard() {
             if (currentIndex < 0) return;
             const plot = plots[currentIndex];
             
             // Common function to write blob to clipboard
             const writeBlob = (blob) => {
                 try {
                     navigator.clipboard.write([new ClipboardItem({'image/png': blob})]).then(() => {
                         vscode.postMessage({ command: 'info', text: 'Copied to clipboard as PNG' });
                     }).catch(err => {
                         console.error('Clipboard write failed', err);
                         // Fallback for some contexts?
                     });
                 } catch (e) { console.error(e); }
             };

             if (plot.data.startsWith('data:image/svg+xml')) {
                 // Convert SVG to PNG via Canvas
                 const img = new Image();
                 img.onload = () => {
                     const canvas = document.createElement('canvas');
                     canvas.width = img.naturalWidth || 800; // Fallback dimensions
                     canvas.height = img.naturalHeight || 600;
                     const ctx = canvas.getContext('2d');
                     
                     // Fill white background (often Clipboard transparent PNGs look bad in some apps)
                     ctx.fillStyle = "white";
                     ctx.fillRect(0, 0, canvas.width, canvas.height);
                     
                     ctx.drawImage(img, 0, 0);
                     
                     canvas.toBlob(blob => {
                         if (blob) writeBlob(blob);
                     }, 'image/png');
                 };
                 img.src = plot.data;
             } else {
                 // Already simple image (presumably png/jpg data uri)
                 fetch(plot.data).then(r => r.blob()).then(writeBlob);
             }
        }
        
        function refreshLayout() {
             // force layout recalc
             const sidebar = document.querySelector('.sidebar');
             // check width
             const w = window.innerWidth;
             const h = window.innerHeight;
             // Switch to vertical (bottom) layout for:
             // - Very narrow screens (w < 500)
             // - Aspect ratios taller than 6:5 (height > width * 0.85)
             if (w < 500 || h > w * 0.85) {
                 document.body.classList.add('layout-vertical');
             } else {
                 document.body.classList.remove('layout-vertical');
             }
        }

        function refreshPlots() {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_plots' }));
            sendResizeEvent();
        }

        function sendResizeEvent() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                const container = document.getElementById('plotContainer');
                if (container) {
                    const containerWidth = Math.floor(container.clientWidth); 
                    const containerHeight = Math.floor(container.clientHeight);
                    
                    // Get current aspect ratio mode
                    const currentState = vscode.getState() || {};
                    const aspectRatio = currentState.aspectRatio || 'auto';
                    
                    let width = containerWidth;
                    let height = containerHeight;
                    
                    // Calculate dimensions based on aspect ratio mode
                    if (aspectRatio === 'square') {
                        const size = Math.min(width, height);
                        width = size;
                        height = size;
                    } else if (aspectRatio === 'landscape') {
                        height = Math.floor(width / 1.5);
                    } else if (aspectRatio === 'portrait') {
                        width = Math.floor(height / 1.5);
                    }
                    // For 'auto' and 'fill', use container dimensions as-is
                    
                    let pid = null;
                    if (currentIndex >= 0 && currentIndex < plots.length) pid = plots[currentIndex].id;
                    
                    if (width > 50 && height > 50) {
                        ws.send(JSON.stringify({ type: 'resize', width, height, plot_id: pid }));
                    }
                }
            }
        }
        
        window.addEventListener('resize', debounce(() => {
            refreshLayout();
            sendResizeEvent();
        }, 200));
        
        
        // Drag and Drop Export Functions
        function handleDragStart(event, index) {
            event.stopPropagation();
            const plot = plots[index];
            event.target.classList.add('dragging');
            fetch(plot.data)
                .then(r => r.blob())
                .then(blob => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('DownloadURL', "image/png:plot_" + (index + 1) + ".png:" + plot.data);
                });
        }
        
        function handleDragEnd(event) {
            event.target.classList.remove('dragging');
        }
        
        // Favorite Functions
        function toggleFavorite(index, event) {
            if (event) event.stopPropagation();
            if (index < 0 || index >= plots.length) return;
            plots[index].isFavorite = !plots[index].isFavorite;
            const currentState = vscode.getState() || {};
            currentState.plots = plots;
            vscode.setState(currentState);
            updatePlotList();
        }
        
        function toggleFavoriteFilter() {
            showOnlyFavorites = !showOnlyFavorites;
            const btn = document.getElementById('favoriteFilterBtn');
            if (showOnlyFavorites) {
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z" /></svg>';
                btn.style.color = '#FFD700';
            } else {
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" /></svg>';
                btn.style.color = '';
            }
            updatePlotList();
        }
        
        // Note Functions
        function showNoteDialog(index, event) {
            if (event) event.stopPropagation();
            if (index < 0 || index >= plots.length) return;
            currentNoteIndex = index;
            const plot = plots[index];
            const modal = document.getElementById('noteModal');
            const textarea = document.getElementById('noteTextarea');
            textarea.value = plot.note || '';
            modal.classList.add('show');
            setTimeout(() => textarea.focus(), 100);
        }
        
        function closeNoteModal() {
            const modal = document.getElementById('noteModal');
            modal.classList.remove('show');
            currentNoteIndex = -1;
        }
        
        function saveNote() {
            if (currentNoteIndex < 0 || currentNoteIndex >= plots.length) return;
            const textarea = document.getElementById('noteTextarea');
            plots[currentNoteIndex].note = textarea.value.trim();
            const currentState = vscode.getState() || {};
            currentState.plots = plots;
            vscode.setState(currentState);
            updatePlotList();
            closeNoteModal();
        }
        
        
        
        document.getElementById('noteModal').addEventListener('click', function(e) {
            if (e.target === this) closeNoteModal();
        });
        
        // Keyboard Navigation: Arrow keys for plot navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                nextPlot();
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                previousPlot();
            } else if (e.key === 'Escape' && isFullscreen) {
                e.preventDefault();
                toggleFullscreen();
            }
        });
        
        // Fullscreen Toggle: Double-click on plot image
        let isFullscreen = false;
        
        function toggleFullscreen() {
            const container = document.getElementById('plotContainer');
            const img = document.getElementById('plotImage');
            const sidebar = document.querySelector('.sidebar');
            const header = document.querySelector('.header');
            
            if (!isFullscreen) {
                // Enter fullscreen
                container.style.position = 'fixed';
                container.style.top = '0';
                container.style.left = '0';
                container.style.width = '100vw';
                container.style.height = '100vh';
                container.style.zIndex = '9999';
                container.style.background = 'var(--bg-primary)';
                container.style.padding = '20px';
                if (img) img.style.cursor = 'zoom-out';
                if (sidebar) sidebar.style.display = 'none';
                if (header) header.style.display = 'none';
            } else {
                // Exit fullscreen
                container.style.position = '';
                container.style.top = '';
                container.style.left = '';
                container.style.width = '';
                container.style.height = '';
                container.style.zIndex = '';
                container.style.background = '';
                container.style.padding = '';
                if (img) img.style.cursor = 'grab';
                if (sidebar) sidebar.style.display = '';
                if (header) header.style.display = '';
            }
            isFullscreen = !isFullscreen;
        }
        
        // Add double-click event to plot image
        const plotImage = document.getElementById('plotImage');
        if (plotImage) {
            plotImage.addEventListener('dblclick', toggleFullscreen);
        }
        
        // Initial layout check
        refreshLayout();
        // Animated Background Logic
        // Canvas removed as per user request to remove background particles/grid
    </script>
</body>
</html>`;
    }
}
