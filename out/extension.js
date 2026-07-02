"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentHasHook = contentHasHook;
exports.addHookToContent = addHookToContent;
exports.removeHookFromContent = removeHookFromContent;
exports.detectLaunchLanguage = detectLaunchLanguage;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
// Structured logging: one output channel + a small ring buffer so the
// "Report Issue" command can attach recent activity to a prefilled GitHub issue.
let outputChannel;
const LOG_BUFFER_MAX = 200;
const logBuffer = [];
function logLine(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_MAX)
        logBuffer.shift();
    outputChannel?.appendLine(line);
}
// Export presets: raster presets carry a scale (DPI multiplier) or fixed
// dimensions; SVG stays vector; PDF embeds the raster at the chosen scale/size.
// Sent to the webview as { format, scale, width, height }.
const EXPORT_PRESETS = [
    { label: 'PNG - Screen', description: '1x, current size', format: 'png', scale: 1 },
    { label: 'PNG - High DPI', description: '2x resolution', format: 'png', scale: 2 },
    { label: 'PNG - Publication', description: '3x (~300 dpi)', format: 'png', scale: 3 },
    { label: 'PNG - Slide 16:9', description: '1920 x 1080', format: 'png', width: 1920, height: 1080 },
    { label: 'PDF - Publication', description: '3x (~300 dpi)', format: 'pdf', scale: 3 },
    { label: 'PDF - Slide 16:9', description: '1920 x 1080', format: 'pdf', width: 1920, height: 1080 },
    { label: 'SVG - Vector', description: 'Scalable, editable', format: 'svg' }
];
// Pick the terminal most likely running R (falls back to the active/first terminal).
function findRTerminal() {
    const isR = (name) => /\b(r|r\.exe|rterm|r interactive|radian)\b/i.test(name);
    return vscode.window.terminals.find(t => isR(t.name))
        ?? vscode.window.activeTerminal
        ?? vscode.window.terminals[0];
}
async function openSourceAt(file, line1, line2) {
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const editor = await vscode.window.showTextDocument(doc);
        if (line1 && line1 > 0) {
            const startLine = line1 - 1;
            const endLine = (line2 && line2 >= line1) ? line2 - 1 : startLine;
            const start = new vscode.Position(startLine, 0);
            const end = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
    }
    catch (e) {
        vscode.window.showErrorMessage('R Plot Pro: Could not open source file — ' + (e?.message ?? e));
    }
}
// Code-actions from the per-plot dropdown. Returns true if it handled the message.
function handleCodeMessage(message) {
    switch (message.command) {
        case 'reveal_code':
        case 'run_code': {
            const term = findRTerminal();
            if (!term) {
                vscode.window.showWarningMessage('R Plot Pro: No terminal to send code to');
                return true;
            }
            term.show(true);
            // reveal = type without executing (newline=false); run = execute (newline=true)
            term.sendText(String(message.code ?? ''), message.command === 'run_code');
            return true;
        }
        case 'open_source':
            if (message.file)
                openSourceAt(String(message.file), message.line1, message.line2);
            else
                vscode.window.showInformationMessage('R Plot Pro: No source file captured for this plot');
            return true;
    }
    return false;
}
async function pickExportPreset() {
    const items = EXPORT_PRESETS.map(p => ({ label: p.label, description: p.description, preset: p }));
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Select export format / preset' });
    if (!chosen)
        return undefined;
    const p = chosen.preset;
    return { format: p.format, scale: p.scale, width: p.width, height: p.height };
}
// Resolve each backend's loopback port to a URL the webview can actually dial.
// The webview always runs in the local UI process, but with Remote-SSH, WSL,
// Dev Containers or Codespaces the R server (and its port) live on the remote
// host, so a raw ws://127.0.0.1:PORT never reaches it. asExternalUri asks VS Code
// to forward/tunnel the port and returns the address that is valid from the UI
// side; on a purely local session it returns the same loopback address.
async function resolveBackends(backends) {
    return Promise.all(backends.map(async (b) => {
        let wsUrl = `ws://127.0.0.1:${b.port}`;
        try {
            const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${b.port}`));
            const scheme = external.scheme === 'https' ? 'wss' : 'ws';
            wsUrl = `${scheme}://${external.authority}`;
        }
        catch (_) {
            // Fall back to the loopback address (expected on local sessions).
        }
        return { ...b, wsUrl };
    }));
}
// --- Startup-hook integration (R .Rprofile / Julia startup.jl) ---
// The most reliable attach path: the language runtime sources our init script at
// startup via an env var, so there is no name-guessing or blind terminal injection.
// Both files use '#' comments, so the marker + add/remove logic is shared.
const HOOK_START = '# [R Plot Pro]';
const HOOK_END = '# [R Plot Pro END]';
const R_HOOK_BODY = 'local({i<-Sys.getenv("RPLOT_PRO_INIT");if(nzchar(i)&&file.exists(i))source(i)})';
const JL_HOOK_BODY = 'let i = get(ENV, "VSC_JL_PLOT_INIT", ""); if !isempty(i) && isfile(i); include(i); end; end';
// --- pure, unit-tested content helpers ---
function contentHasHook(content) {
    return content.includes(HOOK_START);
}
function addHookToContent(content, body) {
    if (content.includes(HOOK_START))
        return content; // already present, idempotent
    const snippet = `${HOOK_START}\n${body}\n${HOOK_END}`;
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    return content + sep + '\n' + snippet + '\n';
}
function removeHookFromContent(content) {
    if (!content.includes(HOOK_START))
        return { content, removed: false };
    // Markers contain regex metacharacters ("[", "]") — escape them before use.
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\n?${esc(HOOK_START)}[\\s\\S]*?${esc(HOOK_END)}\\n?`, 'g');
    const cleaned = content.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    return { content: cleaned + '\n', removed: true };
}
// Identify an interactive R/Julia launch from a shell command line (basename-based,
// so 'rm'/'rsync'/'ruby'/'Rscript' batch are NOT treated as an interactive session).
function detectLaunchLanguage(commandLine) {
    if (!commandLine)
        return null;
    const firstRaw = commandLine.trim().split(/\s+/)[0] || '';
    const first = firstRaw.replace(/^["']|["']$/g, '');
    const base = (first.replace(/\\/g, '/').split('/').pop() || '').replace(/\.exe$/i, '');
    if (base === 'R' || base === 'Rterm' || base.toLowerCase() === 'radian')
        return 'r';
    if (base.toLowerCase() === 'julia' || base.toLowerCase() === 'julialauncher')
        return 'julia';
    return null;
}
function rHook() {
    return { file: path.join(os.homedir(), '.Rprofile'), body: R_HOOK_BODY,
        label: 'R', pretty: '~/.Rprofile', declineKey: 'rprofile.declined' };
}
function juliaHook() {
    return { file: path.join(os.homedir(), '.julia', 'config', 'startup.jl'), body: JL_HOOK_BODY,
        label: 'Julia', pretty: '~/.julia/config/startup.jl', declineKey: 'julia.startup.declined' };
}
function hookInstalled(h) {
    return fs.existsSync(h.file) && contentHasHook(fs.readFileSync(h.file, 'utf8'));
}
function installHook(h) {
    const existing = fs.existsSync(h.file) ? fs.readFileSync(h.file, 'utf8') : '';
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, addHookToContent(existing, h.body), 'utf8');
}
function uninstallHook(h) {
    if (!fs.existsSync(h.file))
        return false;
    const res = removeHookFromContent(fs.readFileSync(h.file, 'utf8'));
    if (res.removed)
        fs.writeFileSync(h.file, res.content, 'utf8');
    return res.removed;
}
async function setupHookIntegration(context, h) {
    if (hookInstalled(h))
        return;
    if (context.globalState.get(h.declineKey))
        return;
    const answer = await vscode.window.showInformationMessage(`R Plot Pro: Add a startup hook to ${h.pretty} so ${h.label} plots are captured instantly when ${h.label} starts — no timing gaps.`, { modal: false }, 'Add hook', "Don't ask again");
    if (answer === 'Add hook') {
        try {
            installHook(h);
            vscode.window.showInformationMessage(`R Plot Pro: ${h.pretty} updated. Restart ${h.label} to activate instant capture.`);
        }
        catch (e) {
            vscode.window.showErrorMessage(`R Plot Pro: Could not write ${h.pretty} — ${e.message}`);
        }
    }
    else if (answer === "Don't ask again") {
        context.globalState.update(h.declineKey, true);
    }
    // undefined = dismissed → ask again next time
}
function activate(context) {
    // Create diagnostic output channel
    outputChannel = vscode.window.createOutputChannel("R Plot Pro");
    context.subscriptions.push(outputChannel);
    logLine("Extension activated.");
    const plotProvider = new PlotViewProvider(context.extensionUri, context.workspaceState);
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
            if (handleCodeMessage(message)) {
                return;
            }
            if (message.command === 'request_config') {
                const backends = plotProvider.getBackends();
                if (backends.length > 0) {
                    resolveBackends(backends).then(rb => panel.webview.postMessage({ command: 'set_ports', backends: rb }));
                }
            }
            else if (message.command === 'open_new_window') {
                vscode.commands.executeCommand('rPlotViewer.openGallery');
            }
            else if (message.command === 'request_export') {
                pickExportPreset().then(opts => {
                    if (opts) {
                        panel.webview.postMessage({ command: 'do_export', ...opts });
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
            resolveBackends(backends).then(rb => panel.webview.postMessage({ command: 'set_ports', backends: rb }));
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
    else {
        // Remove stale port files left by previous R sessions so getBackends()
        // starts at zero and the injection guard doesn't fire prematurely.
        try {
            for (const f of fs.readdirSync(uniqueConfigDir)) {
                if (f.endsWith('.json'))
                    fs.unlinkSync(path.join(uniqueConfigDir, f));
            }
        }
        catch (_) { }
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
    const minPort = rangeCfg.get('minPort', 10000);
    const maxPort = rangeCfg.get('maxPort', 30000);
    context.environmentVariableCollection.replace('RPLOT_PORT_MIN', String(minPort));
    context.environmentVariableCollection.replace('RPLOT_PORT_MAX', String(maxPort));
    plotProvider.setSessionConfigPath(uniqueConfigDir);
    // Gallery archive lives in global storage, keyed by the workspace-stable configId
    // so it persists across sessions and R restarts.
    try {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    }
    catch (_) { /* best-effort */ }
    plotProvider.setArchiveFile(path.join(context.globalStorageUri.fsPath, `archive-${configId}.json`));
    // .Rprofile integration — ask user once, silently skip if already done.
    // (Julia's startup.jl hook is offered lazily, the first time Julia is used.)
    setupHookIntegration(context, rHook());
    // Remove-hook commands (accessible via Command Palette)
    context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.removeFromRprofile', () => {
        if (uninstallHook(rHook())) {
            vscode.window.showInformationMessage('R Plot Pro: Removed hook from ~/.Rprofile.');
            context.globalState.update('rprofile.declined', false); // re-enable future prompts
        }
        else {
            vscode.window.showInformationMessage('R Plot Pro: No hook found in ~/.Rprofile.');
        }
    }), vscode.commands.registerCommand('rPlotViewer.removeFromJuliaStartup', () => {
        if (uninstallHook(juliaHook())) {
            vscode.window.showInformationMessage('R Plot Pro: Removed hook from ~/.julia/config/startup.jl.');
            context.globalState.update('julia.startup.declined', false);
        }
        else {
            vscode.window.showInformationMessage('R Plot Pro: No hook found in ~/.julia/config/startup.jl.');
        }
    }));
    // Report Issue: collect diagnostics + recent log and open a prefilled GitHub issue.
    context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.reportIssue', () => {
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
        const body = `**Describe the problem**\n\n\n**Steps to reproduce**\n\n\n` +
            `**Environment**\n${diag}\n\n` +
            `**Recent log**\n\`\`\`\n${recentLog}\n\`\`\`\n`;
        const url = `https://github.com/ofurkancoban/RPlotPro/issues/new` +
            `?title=${encodeURIComponent('[Bug] ')}&body=${encodeURIComponent(body)}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }));
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
    }
    catch (e) {
        console.error('Failed to watch temp config dir:', e);
        // Fallback to minimal polling
        const fallbackInterval = setInterval(() => discoverPorts(), 5000);
        context.subscriptions.push({ dispose: () => clearInterval(fallbackInterval) });
    }
    const config = vscode.workspace.getConfiguration('rPlotViewer');
    const autoAttach = config.get('autoAttach', true);
    if (autoAttach) {
        const injectedPids = new Set();
        // forceLang lets a reliable signal (shell-integration command detection)
        // drive injection regardless of the terminal name.
        const tryInject = async (terminal, force = false, forceLang) => {
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
            // Detect language by an explicit signal first, else by terminal name.
            const isRTerminal = forceLang === 'r' || (!forceLang && /\b(r|r\.exe|rterm|r interactive)\b/i.test(name));
            const isJuliaTerminal = forceLang === 'julia' || (!forceLang && /\b(julia|julialauncher)\b/i.test(name));
            const sanitizePath = (p) => p.replace(/\\/g, '/');
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
                // Offer the Julia startup hook the first time Julia is actually used
                // (so R-only users never see a Julia prompt).
                setupHookIntegration(context, juliaHook());
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
        let sentinelTimer;
        let sentinelUntil = 0;
        const kickSentinel = (windowMs = 120000) => {
            sentinelUntil = Date.now() + windowMs;
            if (sentinelTimer)
                return;
            sentinelTimer = setInterval(() => {
                if (Date.now() > sentinelUntil) {
                    clearInterval(sentinelTimer);
                    sentinelTimer = undefined;
                    return;
                }
                vscode.window.terminals.forEach(term => tryInject(term));
            }, 3000);
        };
        context.subscriptions.push({ dispose: () => { if (sentinelTimer)
                clearInterval(sentinelTimer); } });
        // Immediate triggers for better UX
        if (vscode.window.activeTerminal)
            tryInject(vscode.window.activeTerminal);
        kickSentinel();
        context.subscriptions.push(vscode.window.onDidOpenTerminal(term => {
            kickSentinel();
            setTimeout(() => tryInject(term), 2000);
        }));
        context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(term => {
            if (term) {
                tryInject(term);
                kickSentinel();
            }
        }));
        // Shell-integration state changes fire when a command runs in a terminal
        // (e.g. the user launches R), re-opening the scan window even without a
        // terminal open/switch — this closes the "idle then start R" gap.
        if (vscode.window.onDidChangeTerminalState) {
            context.subscriptions.push(vscode.window.onDidChangeTerminalState(term => {
                if (term) {
                    tryInject(term);
                    kickSentinel();
                }
            }));
        }
        // Most reliable detection: VS Code shell integration reports the actual
        // command executed at the shell prompt. When it is an interactive R/Julia
        // launch, we know the language for sure (not by terminal name) and the REPL
        // is starting on a clean prompt, so injection cannot corrupt a typed line.
        // Feature-detected: only present on VS Code with the shell-execution API.
        const onExec = vscode.window.onDidStartTerminalShellExecution;
        if (typeof onExec === 'function') {
            context.subscriptions.push(onExec((e) => {
                try {
                    const cmd = e?.execution?.commandLine?.value ?? '';
                    const lang = detectLaunchLanguage(cmd);
                    if (lang) {
                        logLine(`[ShellIntegration] Detected ${lang} launch: ${cmd}`);
                        // Give the REPL a moment to reach its prompt before injecting.
                        setTimeout(() => tryInject(e.terminal, true, lang), lang === 'julia' ? 2500 : 1200);
                    }
                }
                catch (_) { /* best effort */ }
            }));
        }
        context.subscriptions.push(vscode.commands.registerCommand('rPlotViewer.attach', () => {
            const term = vscode.window.activeTerminal;
            if (term) {
                term.show(true);
                tryInject(term, true);
                vscode.window.showInformationMessage(`R Plot Pro: Force-attaching to "${term.name}"...`);
            }
            else {
                vscode.window.showWarningMessage('R Plot Pro: No active terminal to attach to. Focus an R terminal first.');
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
    setArchiveFile(p) {
        this.archiveFile = p;
    }
    readArchive() {
        if (!this.archiveFile)
            return [];
        try {
            if (!fs.existsSync(this.archiveFile))
                return [];
            const parsed = JSON.parse(fs.readFileSync(this.archiveFile, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        }
        catch (_) {
            return [];
        }
    }
    writeArchive(plots) {
        if (!this.archiveFile)
            return;
        try {
            fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
            fs.writeFileSync(this.archiveFile, JSON.stringify(Array.isArray(plots) ? plots : []), 'utf8');
        }
        catch (_) {
            // Non-fatal: archiving is best-effort.
        }
    }
    constructor(_extensionUri, _memento) {
        this._extensionUri = _extensionUri;
        this._memento = _memento;
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
                case 'reveal_code':
                case 'run_code':
                case 'open_source':
                    handleCodeMessage(message);
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
    getBackends() {
        if (!this.sessionConfigPath)
            return [];
        try {
            if (!fs.existsSync(this.sessionConfigPath) || !fs.statSync(this.sessionConfigPath).isDirectory())
                return [];
            const backends = [];
            for (const file of fs.readdirSync(this.sessionConfigPath)) {
                if (!file.endsWith('.json'))
                    continue;
                try {
                    const config = JSON.parse(fs.readFileSync(path.join(this.sessionConfigPath, file), 'utf8'));
                    if (config.port)
                        backends.push({ port: config.port, language: config.language });
                }
                catch (e) { /* skip malformed */ }
            }
            return backends;
        }
        catch (e) {
            console.error('Error reading plot ports:', e);
            return [];
        }
    }
    async checkAndSendConfig() {
        const backends = this.getBackends();
        if (backends.length > 0) {
            this.postMessage({ command: 'set_ports', backends: await resolveBackends(backends) });
        }
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
PlotViewProvider.viewType = 'rPlotViewer.mainView';
//# sourceMappingURL=extension.js.map