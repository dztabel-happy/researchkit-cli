#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function loadMetadata() {
  return require(path.resolve(__dirname, '..', 'platform', 'packages.json'));
}

function platformPackageCandidate(meta) {
  const match = (meta.platform_packages || []).find((pkg) => pkg.os === process.platform && pkg.cpu === process.arch);
  if (!match) throw new Error(`ResearchKit does not support ${process.platform}/${process.arch}.`);

  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${match.package}/package.json`);
  } catch (_) {
    throw new Error(`Required ResearchKit platform package is missing: ${match.package}@${match.version}. Reinstall @dztabel/researchkit with optional dependencies enabled.`);
  }

  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = require(pkgJsonPath);
  const binaryName = meta.binary_name || 'research-kit';
  if (pkgJson.name !== match.package || pkgJson.version !== match.version) {
    throw new Error(`ResearchKit platform package version mismatch: expected ${match.package}@${match.version}, found ${pkgJson.name || 'unknown'}@${pkgJson.version || 'unknown'}.`);
  }
  const binRel = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin && pkgJson.bin[binaryName];
  if (!binRel) throw new Error(`Malformed ResearchKit platform package ${match.package}@${match.version}: missing bin.${binaryName}.`);
  const binary = path.resolve(pkgDir, binRel);
  if (binary !== pkgDir && !binary.startsWith(`${pkgDir}${path.sep}`)) {
    throw new Error(`Malformed ResearchKit platform package ${match.package}@${match.version}: binary path escapes the package.`);
  }
  if (!exists(binary)) throw new Error(`Malformed ResearchKit platform package ${match.package}@${match.version}: binary file is missing at ${binRel}.`);
  return binary;
}

function developmentCandidate(meta) {
  if (process.env[meta.development_mode_env || 'RESEARCHKIT_DEV_MODE'] !== '1') return null;
  const candidates = [];
  if (process.env[meta.env_override || 'RESEARCHKIT_CORE_BIN']) candidates.push(process.env[meta.env_override || 'RESEARCHKIT_CORE_BIN']);

  try {
    candidates.push(require.resolve(`${meta.core_package}/bin/research-kit.js`));
  } catch (_) {}

  candidates.push(path.resolve(__dirname, '..', '..', 'researchkit-cli-core', 'dist', 'research-kit-core.cjs'));
  candidates.push(path.resolve(__dirname, '..', '..', 'researchkit-cli-core', 'bin', 'research-kit.js'));
  candidates.push(path.resolve(process.cwd(), '..', 'researchkit-cli-core', 'dist', 'research-kit-core.cjs'));
  candidates.push(path.resolve(process.cwd(), '..', 'researchkit-cli-core', 'bin', 'research-kit.js'));
  candidates.push(path.resolve(process.cwd(), 'node_modules', '@dztabel', 'researchkit-cli-core', 'bin', 'research-kit.js'));
  return candidates.find((file) => file && exists(file)) || null;
}

function resolveCore() {
  const meta = loadMetadata();
  return developmentCandidate(meta) || platformPackageCandidate(meta);
}

function spawnCore(coreBin, argv) {
  const isJs = /\.(?:c|m)?js$/.test(coreBin);
  const command = isJs ? process.execPath : coreBin;
  const args = isJs ? [coreBin, ...argv] : argv;
  const res = childProcess.spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  process.exit(res.status == null ? 1 : res.status);
}

let core;
try {
  core = resolveCore();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

spawnCore(core, process.argv.slice(2));
