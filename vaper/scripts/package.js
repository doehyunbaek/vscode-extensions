const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const source = path.resolve(__dirname, '..');
const manifest = require(path.join(source, 'package.json'));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vaper-package-'));
const output = path.join(source, `${manifest.name}-${manifest.version}.vsix`);
const included = [
  '.vscodeignore',
  'LICENSE',
  'README.md',
  'extension.js',
  'paper-search.js',
  'media',
  'package.json'
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: staging,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status === 0;
}

try {
  for (const entry of included) {
    fs.cpSync(path.join(source, entry), path.join(staging, entry), { recursive: true });
  }
  if (!run('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts'])) return;
  run('npx', ['--yes', '@vscode/vsce', 'package', '--out', output]);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
