import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/test/**/*.test.js',
    // R Plot Pro declares REditorSupport.r as a hard extensionDependency, so a
    // clean test VS Code must have it installed or our extension will not activate.
    installExtensions: ['REditorSupport.r'],
    mocha: {
        timeout: 60000
    }
});
