#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { assertNativeBinary } = require('./native-binary');
const {
  canonicalPath,
  validateOutputPath,
  assertReleaseOutputOwned,
  writeReleaseOutputMarker
} = require('./release-paths');

const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function publicSource() {
  const commit = childProcess.spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = childProcess.spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  if (commit.status !== 0 || status.status !== 0 || !/^[0-9a-f]{40}$/.test(commit.stdout.trim())) {
    throw new Error('public release source must be a Git checkout with a full commit ID');
  }
  return { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

function ensureInside(parent, file) {
  const relative = path.relative(parent, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe artifact path: ${file}`);
}

function expectedSha(file, binaryRel) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2] === binaryRel) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS does not contain ${binaryRel}`);
}

function selectedEntries(meta, hostOnly) {
  if (!hostOnly) return meta.platform_packages;
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  if (!host) throw new Error(`no host-only package for ${process.platform}/${process.arch}`);
  return [host];
}

function validateBuildMetadata(buildMetadata, rootPackage) {
  if (buildMetadata.version !== rootPackage.version) {
    throw new Error(`core build version mismatch: expected ${rootPackage.version}, found ${buildMetadata.version}`);
  }
  if (buildMetadata.kind !== 'native_executable') {
    throw new Error(`core build metadata kind must be native_executable, found ${buildMetadata.kind}`);
  }
  if (buildMetadata.native_binary !== true) {
    throw new Error('core build metadata native_binary must be true');
  }
  if (buildMetadata.ok !== true) {
    throw new Error('core build metadata ok must be true');
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(buildMetadata.source_commit || '')) {
    throw new Error('core build metadata source_commit must be a full Git object ID');
  }
  if (buildMetadata.source_dirty !== false) {
    throw new Error('core build metadata source_dirty must be false');
  }
  if (!Array.isArray(buildMetadata.targets)) throw new Error('core build metadata targets must be an array');
}

function validateTemplate(template, entry, rootPackage, binaryRel) {
  if (template.private !== true) throw new Error(`platform template must remain private: ${entry.directory}`);
  if (template.name !== entry.package || template.version !== rootPackage.version) {
    throw new Error(`platform template mismatch: ${entry.directory}`);
  }
  if (template.os[0] !== entry.os || template.cpu[0] !== entry.cpu || template.bin['research-kit'] !== binaryRel) {
    throw new Error(`platform template target mismatch: ${entry.directory}`);
  }
  if (template.license !== 'UNLICENSED' || template.files.includes('LICENSE')) {
    throw new Error(`platform template license contract mismatch: ${entry.directory}`);
  }
  if (JSON.stringify(template.repository) !== JSON.stringify(rootPackage.repository)) {
    throw new Error(`platform template repository mismatch: ${entry.directory}`);
  }
}

function validatePlatformEntry(entry) {
  const expectedDirectory = `${entry.os}-${entry.cpu}`;
  if (!new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']).has(expectedDirectory)) {
    throw new Error(`unsupported platform metadata: ${expectedDirectory}`);
  }
  if (entry.directory !== expectedDirectory) {
    throw new Error(`platform directory metadata mismatch: ${entry.directory}`);
  }
  const binaryRel = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
  if (entry.artifact !== `platforms/${entry.directory}/${binaryRel}`) {
    throw new Error(`platform artifact metadata mismatch: ${entry.directory}`);
  }
  return binaryRel;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifacts || !args.output) {
    throw new Error('usage: stage-release --artifacts <core-build-dir> --output <staging-dir> [--host-only]');
  }
  const artifacts = canonicalPath(args.artifacts);
  const output = canonicalPath(args.output);
  validateOutputPath(output, artifacts, canonicalPath(root), canonicalPath(os.homedir()));
  const rootPackage = readJson(path.join(root, 'package.json'));
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const buildMetadata = readJson(path.join(artifacts, 'build-metadata.json'));
  validateBuildMetadata(buildMetadata, rootPackage);
  const entries = selectedEntries(meta, args['host-only']);
  const validated = [];
  for (const entry of entries) {
    const binaryRel = validatePlatformEntry(entry);
    const templateDir = path.join(root, 'platform-packages', entry.directory);
    const template = readJson(path.join(templateDir, 'package.json'));
    validateTemplate(template, entry, rootPackage, binaryRel);
    const source = canonicalPath(path.resolve(artifacts, entry.artifact));
    ensureInside(artifacts, source);
    if (!fs.statSync(source).isFile()) throw new Error(`core artifact missing: ${entry.artifact}`);

    const built = (buildMetadata.targets || []).find((target) => target.key === entry.directory);
    if (!built) throw new Error(`build metadata target missing: ${entry.directory}`);
    if (built.artifact !== entry.artifact || built.os !== entry.os || built.cpu !== entry.cpu) {
      throw new Error(`build metadata target mismatch: ${entry.directory}`);
    }
    if (built.smoke_ok !== true) throw new Error(`core artifact smoke evidence must be true: ${entry.directory}`);
    assertNativeBinary(source, entry.os, entry.cpu, entry.directory);
    const digest = sha256(source);
    const sumsFile = canonicalPath(path.join(artifacts, 'platforms', entry.directory, 'SHA256SUMS'));
    ensureInside(artifacts, sumsFile);
    if (expectedSha(sumsFile, binaryRel) !== digest || built.sha256 !== digest) {
      throw new Error(`core artifact checksum mismatch: ${entry.directory}`);
    }
    const sourceStat = fs.statSync(source);
    if (built.size !== sourceStat.size) throw new Error(`core artifact size mismatch: ${entry.directory}`);

    const packageManifest = { ...template };
    delete packageManifest.private;
    const packageDir = path.resolve(output, entry.directory);
    const destination = path.resolve(packageDir, binaryRel);
    const manifestDestination = path.join(packageDir, 'package.json');
    const checksumsDestination = path.join(packageDir, 'checksums.json');
    ensureInside(output, packageDir);
    for (const file of [destination, manifestDestination, checksumsDestination]) ensureInside(packageDir, file);
    validated.push({
      entry,
      binaryRel,
      source,
      sourceStat,
      digest,
      packageManifest,
      packageDir,
      destination,
      manifestDestination,
      checksumsDestination
    });
  }

  const publicSourceMetadata = publicSource();
  assertReleaseOutputOwned(output);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  writeReleaseOutputMarker(output);
  const staged = [];
  for (const item of validated) {
    const {
      entry,
      binaryRel,
      source,
      sourceStat,
      digest,
      packageManifest,
      packageDir,
      destination,
      manifestDestination,
      checksumsDestination
    } = item;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, sourceStat.mode & 0o777);
    fs.writeFileSync(manifestDestination, `${JSON.stringify(packageManifest, null, 2)}\n`);
    fs.writeFileSync(checksumsDestination, `${JSON.stringify({
      algorithm: 'sha256',
      package: entry.package,
      version: entry.version,
      files: { [binaryRel]: digest }
    }, null, 2)}\n`);
    staged.push({ target: entry.directory, package: entry.package, binary: binaryRel, sha256: digest });
  }

  fs.writeFileSync(path.join(output, 'release-metadata.json'), `${JSON.stringify({
    schema_version: '1.0.0',
    version: rootPackage.version,
    public_source: publicSourceMetadata,
    source_build: buildMetadata,
    packages: staged
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, version: rootPackage.version, package_count: staged.length, output }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`release staging failed: ${error.message}`);
  process.exit(1);
}
