import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'ofurkancoban.r-plot-pro';

// Commands contributed in package.json - all must be registered after activation.
const CONTRIBUTED_COMMANDS = [
    'rPlotViewer.showPlot',
    'rPlotViewer.clearPlot',
    'rPlotViewer.exportPlot',
    'rPlotViewer.previousPlot',
    'rPlotViewer.nextPlot',
    'rPlotViewer.removeFromRprofile',
    'rPlotViewer.removeFromJuliaStartup',
    'rPlotViewer.reportIssue',
    'rPlotViewer.attach'
];

suite('R Plot Pro smoke tests', () => {
    test('extension is present and activates (regression for #4)', async () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        assert.ok(ext, `extension ${EXT_ID} should be discoverable`);
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true, 'extension should activate without a blocked dependency');
    });

    test('all contributed commands are registered', async () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        await ext!.activate();
        const commands = await vscode.commands.getCommands(true);
        for (const cmd of CONTRIBUTED_COMMANDS) {
            assert.ok(commands.includes(cmd), `command "${cmd}" should be registered`);
        }
    });

    test('does not hard-depend on the Julia extension', () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        const deps: string[] = ext!.packageJSON.extensionDependencies || [];
        assert.ok(
            !deps.includes('julialang.language-julia'),
            'Julia must be optional so activation never blocks on it (see #4)'
        );
    });
});
