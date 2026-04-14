"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
function activate(context) {
    // Create diagnostic output channel
    const outputChannel = vscode.window.createOutputChannel("R Plot Pro");
    outputChannel.appendLine("R Plot Pro: Extension activated.");
    const plotProvider = new PlotViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('rPlotViewer.mainView', plotProvider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    }));
    // Register commands that forward actions to the webview
    context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.showPlot', () => {
        vscode.commands.executeCommand('rPlotViewer.mainView.focus');
    }), vscode.commands.registerCommand('rPlotViewer.clearPlot', () => {
        plotProvider.postMessage({ command: 'clear_plots' });
    }), vscode.commands.registerCommand('rPlotViewer.exportPlot', () => {
        plotProvider.postMessage({ command: 'export_plot' });
    }), vscode.commands.registerCommand('rPlotViewer.previousPlot', () => {
        plotProvider.postMessage({ command: 'previous_plot' });
    }), vscode.commands.registerCommand('rPlotViewer.nextPlot', () => {
        plotProvider.postMessage({ command: 'next_plot' });
    }), vscode.commands.registerCommand('rPlotViewer.openGallery', () => {
        const panel = vscode.window.createWebviewPanel('rPlotGallery', 'R Plot Gallery', vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [context.extensionUri],
            retainContextWhenHidden: true
        });
        panel.webview.html = plotProvider._getHtmlForWebview(panel.webview);
        // Move to a separate floating window
        // Use minimal delay (100ms) for fast window opening while avoiding race conditions
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(() => { }, (err) => { console.error('Failed to move to new window:', err); });
        }, 100);
        // Forward messages from panel to handle export/config same way
        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'request_config') {
                const backends = plotProvider.getBackends();
                if (backends.length > 0) {
                    panel.webview.postMessage({ command: 'set_ports', backends: backends });
                }
            }
            else if (message.command === 'open_new_window') {
                vscode.commands.executeCommand('rPlotViewer.openGallery');
            }
            else if (message.command === 'request_export') {
                vscode.window.showQuickPick(['PNG', 'SVG'], { placeHolder: 'Select format to save' }).then(format => {
                    if (format) {
                        panel.webview.postMessage({ command: 'do_export', format: format.toLowerCase() });
                    }
                });
            }
            else if (message.command === 'save_data') {
                vscode.window.showSaveDialog({
                    filters: { 'Images': [message.format] },
                    defaultUri: vscode.Uri.file('plot.' + message.format)
                }).then(uri => {
                    if (uri) {
                        try {
                            const base64Data = message.data.includes(',') ? message.data.split(',')[1] : message.data;
                            fs.writeFileSync(uri.fsPath, Buffer.from(base64Data, 'base64'));
                            vscode.window.showInformationMessage(`Plot saved as ${message.format.toUpperCase()}`);
                        }
                        catch (e) {
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
    }));
    // Config logic
    const configIdKey = 'r.plot.config.id';
    let configId = context.workspaceState.get(configIdKey);
    if (!configId) {
        configId = `vscode-r-plot-config-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        context.workspaceState.update(configIdKey, configId);
    }
    const uniqueConfigDir = path.join(os.tmpdir(), configId).replace(/\\/g, '/');
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
    const discoverPorts = (configDir) => {
        try {
            if (fs.existsSync(configDir) && fs.statSync(configDir).isDirectory()) {
                const files = fs.readdirSync(configDir);
                const backends = [];
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
                        }
                        catch (e) { /* skip malformed */ }
                    }
                }
                if (backends.length > 0) {
                    plotProvider.postMessage({ command: 'set_ports', backends: backends });
                }
            }
        }
        catch (e) {
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
    }
    catch (e) {
        console.error('Failed to watch temp config dir:', e);
        // Fallback to minimal polling
        const fallbackInterval = setInterval(() => discoverPorts(uniqueConfigDir), 5000);
        context.subscriptions.push({ dispose: () => clearInterval(fallbackInterval) });
    }
    const config = vscode.workspace.getConfiguration('rPlotViewer');
    const autoAttach = config.get('autoAttach', true);
    if (autoAttach) {
        const injectedPids = new Set();
        const tryInject = async (terminal, force = false) => {
            if (!terminal)
                return;
            let pid;
            try {
                pid = await terminal.processId;
            }
            catch (e) {
                return;
            }
            if (!pid)
                return;
            if (!force && injectedPids.has(pid))
                return;
            const name = terminal.name;
            const shellPath = terminal.creationOptions?.shellPath || '';
            // Neural Precision: Match standalone keywords using word boundaries \b (Mac support)
            const isRTerminal = /\b(r|r\.exe|rterm|r interactive)\b/i.test(name);
            const isJuliaTerminal = /\b(julia|julialauncher)\b/i.test(name);
            const sanitizePath = (p) => p.replace(/\\/g, '/');
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
                }, 3000);
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
        if (vscode.window.activeTerminal)
            tryInject(vscode.window.activeTerminal);
        context.subscriptions.push(vscode.window.onDidOpenTerminal(term => {
            setTimeout(() => tryInject(term), 2000);
        }));
        context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(term => {
            if (term)
                tryInject(term);
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
    const updateActiveFile = (editor) => {
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
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateActiveFile));
}
function deactivate() { }
class PlotViewProvider {
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    setSessionConfigPath(path) {
        this.sessionConfigPath = path;
    }
    resolveWebviewView(webviewView, _context, _token) {
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
                            }
                            catch (e) {
                                vscode.window.showErrorMessage('Failed to save plot: ' + e.message);
                            }
                        }
                    });
                    break;
            }
        });
    }
    checkAndSendConfig() {
        try {
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath) && fs.statSync(this.sessionConfigPath).isDirectory()) {
                const files = fs.readdirSync(this.sessionConfigPath);
                const backends = [];
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
                        }
                        catch (e) { /* skip */ }
                    }
                }
                if (backends.length > 0) {
                    this.postMessage({ command: 'set_ports', backends: backends });
                }
            }
        }
        catch (e) {
            console.error('Error reading plot ports on request:', e);
        }
    }
    getBackends() {
        try {
            if (this.sessionConfigPath && fs.existsSync(this.sessionConfigPath) && fs.statSync(this.sessionConfigPath).isDirectory()) {
                const files = fs.readdirSync(this.sessionConfigPath);
                const backends = [];
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
                        }
                        catch (e) { /* skip */ }
                    }
                }
                return backends;
            }
        }
        catch (e) {
            console.error('Error reading ports:', e);
        }
        return [];
    }
    postMessage(message) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }
    sendActiveFile(filePath) {
        this.postMessage({
            command: 'set_active_file',
            filePath: filePath
        });
    }
    _getHtmlForWebview(webview) {
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
PlotViewProvider.viewType = 'rPlotViewer.mainView';
//# sourceMappingURL=extension.js.map