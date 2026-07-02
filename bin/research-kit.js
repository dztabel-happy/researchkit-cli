#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

function exists(file) {
  try { fs.accessSync(file); return true; } catch (_) { return false; }
}

function resolveCore() {
  const candidates = [];
  if (process.env.RESEARCHKIT_CORE_BIN) candidates.push(process.env.RESEARCHKIT_CORE_BIN);

  try {
    candidates.push(require.resolve('@dztabel/researchkit-cli-core/bin/research-kit.js'));
  } catch (_) {}

  candidates.push(path.resolve(__dirname, '..', '..', 'researchkit-cli-core', 'dist', 'research-kit-core.cjs'));
  candidates.push(path.resolve(__dirname, '..', '..', 'researchkit-cli-core', 'bin', 'research-kit.js'));
  candidates.push(path.resolve(process.cwd(), '..', 'researchkit-cli-core', 'dist', 'research-kit-core.cjs'));
  candidates.push(path.resolve(process.cwd(), '..', 'researchkit-cli-core', 'bin', 'research-kit.js'));
  candidates.push(path.resolve(process.cwd(), 'node_modules', '@dztabel', 'researchkit-cli-core', 'bin', 'research-kit.js'));

  return candidates.find(Boolean) && candidates.find((file) => exists(file));
}

function spawnCore(coreBin, argv) {
  const isJs = coreBin.endsWith('.js');
  const command = isJs ? process.execPath : coreBin;
  const args = isJs ? [coreBin, ...argv] : argv;
  const res = childProcess.spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  process.exit(res.status == null ? 1 : res.status);
}

const core = resolveCore();
if (!core) {
  console.error([
    'ResearchKit core binary was not found.',
    '',
    'Use one of the following local setups:',
    '  1. export RESEARCHKIT_CORE_BIN=/absolute/path/to/researchkit-cli-core/bin/research-kit.js or dist/research-kit-core.cjs',
    '  2. put researchkit-cli and researchkit-cli-core as sibling directories, then run this wrapper',
    '  3. npm link the private @dztabel/researchkit-cli-core package into this wrapper project',
    '',
    'This public package is intentionally a thin entrypoint; the audit/lint/stage-gate logic lives in the private core.'
  ].join('\n'));
  process.exit(1);
}

spawnCore(core, process.argv.slice(2));
