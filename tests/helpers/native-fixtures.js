'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = "const arg = process.argv[2]; if (arg === '--version') console.log('research-kit 0.1.0'); else if (arg === '--help') console.log('ResearchKit CLI core'); else console.log('ResearchKit native fixture');\n";
const targets = [
  { directory: 'darwin-arm64', target: 'bun-darwin-arm64', binary: 'research-kit' },
  { directory: 'darwin-x64', target: 'bun-darwin-x64', binary: 'research-kit' },
  { directory: 'linux-x64', target: 'bun-linux-x64-baseline', binary: 'research-kit' },
  { directory: 'win32-x64', target: 'bun-windows-x64-baseline', binary: 'research-kit.exe' }
];

let fixtureRoot;

function buildFixtures() {
  if (fixtureRoot) return fixtureRoot;
  const bun = process.env.BUN_BIN || 'bun';
  const version = childProcess.spawnSync(bun, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`Bun is required for native fixture tests: ${version.stderr || version.error || ''}`.trim());
  const key = crypto.createHash('sha256')
    .update(version.stdout.trim())
    .update(source)
    .update(JSON.stringify(targets))
    .digest('hex')
    .slice(0, 16);
  const cache = path.join(os.tmpdir(), `researchkit-native-fixtures-${key}`);
  const ready = path.join(cache, 'READY');
  const complete = () => fs.existsSync(ready) && targets.every((target) => {
    const file = path.join(cache, target.directory, target.binary);
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  });
  if (complete()) {
    fixtureRoot = cache;
    return fixtureRoot;
  }
  fs.rmSync(cache, { recursive: true, force: true });

  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-native-fixtures-build-'));
  const entry = path.join(build, 'fixture.js');
  fs.writeFileSync(entry, source);
  for (const target of targets) {
    const output = path.join(build, target.directory, target.binary);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = childProcess.spawnSync(bun, [
      'build', entry,
      '--compile',
      '--target', target.target,
      '--outfile', output
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      fs.rmSync(build, { recursive: true, force: true });
      throw new Error(`Bun native fixture build failed for ${target.target}: ${result.stderr || result.stdout}`.trim());
    }
    if (target.directory !== 'win32-x64') fs.chmodSync(output, 0o755);
  }
  fs.unlinkSync(entry);
  fs.writeFileSync(path.join(build, 'READY'), `${key}\n`);
  try {
    fs.renameSync(build, cache);
  } catch (error) {
    if (!complete()) throw error;
    fs.rmSync(build, { recursive: true, force: true });
  }
  fixtureRoot = cache;
  return fixtureRoot;
}

function nativeFixturePath(entry) {
  const target = targets.find((item) => item.directory === entry.directory);
  if (!target) throw new Error(`unsupported native fixture: ${entry.directory}`);
  return path.join(buildFixtures(), target.directory, target.binary);
}

function installNativeFixture(entry, destination) {
  const sourceFile = nativeFixturePath(entry);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.linkSync(sourceFile, destination);
  } catch (_) {
    fs.copyFileSync(sourceFile, destination);
  }
  if (entry.os !== 'win32') fs.chmodSync(destination, 0o755);
}

module.exports = { installNativeFixture, nativeFixturePath };
