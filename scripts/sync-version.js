#!/usr/bin/env node
/**
 * Single source of truth for the extension version.
 * Reads `version` from package.json and rewrites the hardcoded copies in the
 * R sources and the README badge. Runs automatically before packaging
 * (vscode:prepublish) so a published build can never carry a stale version.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;

const edits = [
    {
        file: 'init.R',
        // this_version <- "0.47.0"
        pattern: /this_version\s*<-\s*"[^"]*"/,
        replacement: `this_version <- "${version}"`
    },
    {
        file: 'plot_server.R',
        // version = "0.47.0"  (inside the port config JSON, appears twice)
        pattern: /version = "[0-9][^"]*"/g,
        replacement: `version = "${version}"`
    },
    {
        file: 'plot_server.R',
        // .vsc_rplot$version  <- "0.47.0"
        pattern: /(\.vsc_rplot\$version\s*<-\s*)"[^"]*"/,
        replacement: `$1"${version}"`
    },
    {
        file: 'README.md',
        // .../badge/Version-0.47.0-green?...
        pattern: /Version-[^-\s]+-green/,
        replacement: `Version-${version}-green`
    }
];

let changed = 0;
for (const edit of edits) {
    const filePath = path.join(root, edit.file);
    if (!fs.existsSync(filePath)) {
        console.warn(`sync-version: skip missing ${edit.file}`);
        continue;
    }
    const before = fs.readFileSync(filePath, 'utf8');
    const after = before.replace(edit.pattern, edit.replacement);
    if (after !== before) {
        fs.writeFileSync(filePath, after, 'utf8');
        changed++;
        console.log(`sync-version: updated ${edit.file} -> ${version}`);
    }
}

console.log(`sync-version: version ${version} (${changed} file section(s) updated)`);
