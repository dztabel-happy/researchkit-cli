#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { assertNativeBinary } = require('./native-binary');
const { RELEASE_OUTPUT_MARKER, RELEASE_OUTPUT_MARKER_CONTENT } = require('./release-paths');

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

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe staged path: ${file}`);
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`.trim());
  return result.stdout;
}

function runNpm(args, options = {}) {
  if (process.platform === 'win32') {
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], options);
  }
  return run('npm', args, options);
}

function npmArgs(cache, args) {
  return [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--userconfig', '/dev/null'];
}

function pack(directory, destination, cache) {
  const output = runNpm(npmArgs(cache, ['pack', '--json', '--pack-destination', destination]), { cwd: directory });
  const result = JSON.parse(output)[0];
  return { tarball: path.join(destination, result.filename), files: result.files.map((file) => file.path) };
}

function tarText(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function tarEntries(tarball) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarball));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = Number.parseInt(tarText(header, 148, 8), 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!Number.isSafeInteger(expectedChecksum) || expectedChecksum !== actualChecksum) {
      throw new Error('release archive header checksum mismatch');
    }
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const file = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(tarText(header, 124, 12) || '0', 8);
    const mode = Number.parseInt(tarText(header, 100, 8) || '0', 8);
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mode) || mode < 0 || end > archive.length) {
      throw new Error('release archive is malformed');
    }
    if (header[156] !== 0 && header[156] !== 48) throw new Error(`release archive entry type is unsupported: ${file}`);
    if (entries.has(file)) throw new Error(`release archive has duplicate file: ${file}`);
    entries.set(file, { data: Buffer.from(archive.subarray(start, end)), mode });
    offset = start + (Math.ceil(size / 512) * 512);
  }
  return entries;
}

function archiveEntry(entries, file, label) {
  const entry = entries.get(`package/${file}`);
  if (!entry) throw new Error(`${label} missing: ${file}`);
  return entry;
}

function archiveJson(entries, file, label) {
  try {
    return JSON.parse(archiveEntry(entries, file, label).data.toString('utf8'));
  } catch (error) {
    if (/ missing: /.test(error.message)) throw error;
    throw new Error(`${label} invalid: ${file}`);
  }
}

function packageFiles(entries) {
  return [...entries.keys()].map((file) => {
    if (!file.startsWith('package/') || file.length === 8) throw new Error(`release archive file is outside package: ${file}`);
    return file.slice(8);
  }).sort();
}

function rejectInstallScripts(manifest, label) {
  for (const name of ['preinstall', 'install', 'postinstall']) {
    if (Object.hasOwn(manifest.scripts || {}, name)) throw new Error(`${label} install lifecycle script is not allowed: ${name}`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RESEARCHKIT_')) delete env[key];
  }
  return env;
}

function validateMetadata(rootPackage, meta) {
  const repository = { type: 'git', url: 'https://github.com/dztabel-happy/researchkit-cli.git' };
  if (!sameJson(rootPackage.repository, repository)) throw new Error('root package repository metadata mismatch');
  if (rootPackage.license !== 'UNLICENSED' || rootPackage.files.includes('LICENSE')) {
    throw new Error('root package license contract mismatch');
  }
  const expected = Object.fromEntries(meta.platform_packages.map((entry) => [entry.package, rootPackage.version]));
  if (JSON.stringify(rootPackage.optionalDependencies) !== JSON.stringify(expected)) {
    throw new Error('optionalDependencies do not match platform metadata');
  }
  for (const entry of meta.platform_packages) {
    const expectedDirectory = `${entry.os}-${entry.cpu}`;
    if (!new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']).has(expectedDirectory)
      || entry.directory !== expectedDirectory) throw new Error(`platform directory metadata mismatch: ${entry.directory}`);
    const expectedBinary = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
    if (entry.artifact !== `platforms/${entry.directory}/${expectedBinary}`) throw new Error(`platform artifact metadata mismatch: ${entry.directory}`);
    if (entry.version !== rootPackage.version) throw new Error(`platform version mismatch: ${entry.package}`);
    const template = readJson(path.join(root, 'platform-packages', entry.directory, 'package.json'));
    if (template.name !== entry.package || template.version !== entry.version) throw new Error(`platform template mismatch: ${entry.package}`);
    if (template.os[0] !== entry.os || template.cpu[0] !== entry.cpu) throw new Error(`platform target mismatch: ${entry.package}`);
    if (template.bin[meta.binary_name] !== expectedBinary) throw new Error(`platform binary metadata mismatch: ${entry.package}`);
    if (template.private !== true) throw new Error(`platform template must remain private: ${entry.package}`);
    if (template.license !== 'UNLICENSED' || template.files.includes('LICENSE')) {
      throw new Error(`platform template license contract mismatch: ${entry.package}`);
    }
    if (!sameJson(template.repository, repository)) throw new Error(`platform repository metadata mismatch: ${entry.package}`);
  }
}

function selectedEntries(meta, hostOnly) {
  if (!hostOnly) return meta.platform_packages;
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  if (!host) throw new Error(`no host-only package for ${process.platform}/${process.arch}`);
  return [host];
}

function validateSourceBuild(sourceBuild, entries) {
  if (!sourceBuild || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sourceBuild.source_commit || '')) {
    throw new Error('release metadata source_commit must be a full Git object ID');
  }
  if (sourceBuild.source_dirty !== false) throw new Error('release metadata source_dirty must be false');
  if (!Array.isArray(sourceBuild.targets)) throw new Error('release metadata targets must be an array');
  for (const entry of entries) {
    const target = sourceBuild.targets.find((item) => item.key === entry.directory);
    if (!target || target.smoke_ok !== true) throw new Error(`release metadata smoke evidence must be true: ${entry.directory}`);
  }
}

function validateStage(stage, meta, entries, rootPackage) {
  const marker = path.join(stage, RELEASE_OUTPUT_MARKER);
  if (!fs.existsSync(marker) || !fs.lstatSync(marker).isFile() || fs.readFileSync(marker, 'utf8') !== RELEASE_OUTPUT_MARKER_CONTENT) {
    throw new Error('release stage ownership marker missing or invalid');
  }
  const release = readJson(path.join(stage, 'release-metadata.json'));
  if (release.version !== rootPackage.version) throw new Error('release metadata version mismatch');
  validateSourceBuild(release.source_build, entries);
  const currentPublic = publicSource();
  if (release.public_source?.commit !== currentPublic.commit) throw new Error('public source commit mismatch');
  if (release.public_source?.dirty !== false || currentPublic.dirty) throw new Error('public source must be clean for release');
  if (!Array.isArray(release.packages) || release.packages.length !== entries.length) {
    throw new Error('release metadata package count mismatch');
  }

  for (const entry of entries) {
    const packageDir = path.resolve(stage, entry.directory);
    ensureInside(stage, packageDir);
    const packageJson = readJson(path.join(packageDir, 'package.json'));
    if (Object.hasOwn(packageJson, 'private')) throw new Error(`staged package must be publishable: ${entry.directory}`);
    if (packageJson.name !== entry.package || packageJson.version !== entry.version) throw new Error(`staged package metadata mismatch: ${entry.directory}`);
    if (packageJson.license !== 'UNLICENSED' || packageJson.files.includes('LICENSE')) {
      throw new Error(`staged package license contract mismatch: ${entry.directory}`);
    }
    if (packageJson.os[0] !== entry.os || packageJson.cpu[0] !== entry.cpu) throw new Error(`staged package target mismatch: ${entry.directory}`);
    const binaryRel = packageJson.bin[meta.binary_name];
    const expectedBinary = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
    if (binaryRel !== expectedBinary) throw new Error(`staged package binary mismatch: ${entry.directory}`);
    const binary = path.resolve(packageDir, binaryRel);
    ensureInside(packageDir, binary);
    const checksums = readJson(path.join(packageDir, 'checksums.json'));
    const digest = sha256(binary);
    if (checksums.files[binaryRel] !== digest) throw new Error(`checksum mismatch: ${entry.directory}`);
    assertNativeBinary(binary, entry.os, entry.cpu, entry.directory);
    const binaryStat = fs.statSync(binary);
    if (entry.os !== 'win32' && (binaryStat.mode & 0o111) === 0) throw new Error(`executable mode missing: ${entry.directory}`);
    const sourceTarget = release.source_build.targets.find((item) => item.key === entry.directory);
    if (sourceTarget.os !== entry.os || sourceTarget.cpu !== entry.cpu || sourceTarget.artifact !== entry.artifact) {
      throw new Error(`source build artifact metadata mismatch: ${entry.directory}`);
    }
    if (sourceTarget.sha256 !== digest) throw new Error(`source build artifact checksum mismatch: ${entry.directory}`);
    if (sourceTarget.size !== binaryStat.size) throw new Error(`source build artifact size mismatch: ${entry.directory}`);
    const released = release.packages.find((item) => item.target === entry.directory);
    if (!released || released.package !== entry.package || released.binary !== binaryRel || released.sha256 !== digest) {
      throw new Error(`release package metadata mismatch: ${entry.directory}`);
    }
  }
  return release;
}

function archiveDescriptor(stage, tarball, extra = {}) {
  const data = fs.readFileSync(tarball);
  return {
    ...extra,
    file: path.relative(stage, tarball).split(path.sep).join('/'),
    sha256: sha256Buffer(data),
    integrity: `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`,
    size: data.length
  };
}

function expectedRootArchive() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-root-pack-'));
  try {
    const packed = pack(root, temporary, path.join(temporary, 'npm-cache'));
    return tarEntries(packed.tarball);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function packageDistribution(stage, entries, rootPackage) {
  const packagesDir = path.join(stage, 'packages');
  ensureInside(stage, packagesDir);
  fs.rmSync(packagesDir, { recursive: true, force: true });
  fs.mkdirSync(packagesDir, { recursive: true });
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-pack-cache-')), 'npm-cache');
  const rootPack = pack(root, packagesDir, cache);
  for (const required of ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', 'skills/deep-research-report/SKILL.md', 'skills/deep-research-report/agents/openai.yaml']) {
    if (!rootPack.files.includes(required)) throw new Error(`public package content missing: ${required}`);
  }
  const platforms = entries.map((entry) => {
    const packed = pack(path.join(stage, entry.directory), packagesDir, cache);
    return archiveDescriptor(stage, packed.tarball, { target: entry.directory, package: entry.package });
  });
  return {
    root: archiveDescriptor(stage, rootPack.tarball, { package: rootPackage.name, files: rootPack.files.slice().sort() }),
    platforms
  };
}

function verifyDistribution(stage, release, entries, rootPackage) {
  const distribution = release.distribution;
  if (!distribution || distribution.root?.package !== rootPackage.name || !Array.isArray(distribution.platforms)) {
    throw new Error('release distribution metadata missing');
  }
  if (distribution.platforms.length !== entries.length) throw new Error('release distribution platform set mismatch');
  const verified = new Map();
  const descriptors = [distribution.root, ...distribution.platforms];
  const targets = new Set(distribution.platforms.map((item) => item.target));
  if (entries.some((entry) => !targets.has(entry.directory)) || targets.size !== entries.length) throw new Error('release distribution platform set mismatch');
  for (const descriptor of descriptors) {
    const file = path.resolve(stage, descriptor.file || '');
    ensureInside(path.join(stage, 'packages'), file);
    if (path.extname(file) !== '.tgz' || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('release distribution archive missing');
    const data = fs.readFileSync(file);
    const integrity = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
    if (sha256Buffer(data) !== descriptor.sha256 || data.length !== descriptor.size || integrity !== descriptor.integrity) {
      throw new Error(`distribution checksum mismatch or integrity mismatch: ${descriptor.file}`);
    }
    verified.set(descriptor, file);
  }

  const rootArchive = tarEntries(verified.get(distribution.root));
  const expectedArchive = expectedRootArchive();
  const rootManifest = archiveJson(rootArchive, 'package.json', 'root package');
  rejectInstallScripts(rootManifest, 'root package');
  if (!sameJson(rootManifest, rootPackage)) throw new Error('root package manifest mismatch');
  const rootFiles = packageFiles(rootArchive);
  const expectedFiles = packageFiles(expectedArchive);
  if (!Array.isArray(distribution.root.files)
    || !sameJson(rootFiles, expectedFiles)
    || !sameJson(rootFiles, distribution.root.files.slice().sort())) {
    throw new Error('root package contents mismatch');
  }
  for (const file of expectedFiles) {
    const actual = archiveEntry(rootArchive, file, 'root package');
    const expected = archiveEntry(expectedArchive, file, 'current public package');
    if (!actual.data.equals(expected.data) || actual.mode !== expected.mode) throw new Error(`root package file mismatch: ${file}`);
  }
  const wrapper = archiveEntry(rootArchive, rootPackage.bin['research-kit'], 'root package wrapper');
  if (!wrapper.data.equals(fs.readFileSync(path.join(root, rootPackage.bin['research-kit'])))) {
    throw new Error('root package wrapper mismatch');
  }
  if ((wrapper.mode & 0o111) === 0) throw new Error('root package wrapper executable mode missing');

  for (const entry of entries) {
    const descriptor = distribution.platforms.find((item) => item.target === entry.directory);
    const archive = tarEntries(verified.get(descriptor));
    const manifest = archiveJson(archive, 'package.json', 'platform package');
    const expectedBinary = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
    rejectInstallScripts(manifest, 'platform package');
    const stagedManifest = readJson(path.join(stage, entry.directory, 'package.json'));
    if (descriptor.package !== entry.package || !sameJson(manifest, stagedManifest)) {
      throw new Error(`platform package manifest mismatch: ${entry.directory}`);
    }
    const expectedFiles = ['checksums.json', 'package.json', expectedBinary].sort();
    if (!sameJson(packageFiles(archive), expectedFiles)) throw new Error(`platform package contents mismatch: ${entry.directory}`);
    const binary = archiveEntry(archive, expectedBinary, 'platform package binary');
    const digest = sha256Buffer(binary.data);
    const sourceTarget = release.source_build.targets.find((item) => item.key === entry.directory);
    if (sourceTarget.sha256 !== digest) throw new Error(`platform package binary checksum mismatch: ${entry.directory}`);
    if (sourceTarget.size !== binary.data.length) throw new Error(`platform package binary size mismatch: ${entry.directory}`);
    if (entry.os !== 'win32' && (binary.mode & 0o111) === 0) {
      throw new Error(`platform package binary executable mode missing: ${entry.directory}`);
    }
    const checksums = archiveJson(archive, 'checksums.json', 'platform package checksums');
    if (checksums.algorithm !== 'sha256'
      || checksums.package !== entry.package
      || checksums.version !== entry.version
      || !sameJson(Object.keys(checksums.files || {}).sort(), [expectedBinary])
      || checksums.files[expectedBinary] !== digest) {
      throw new Error(`platform package checksums mismatch: ${entry.directory}`);
    }
  }
}

function cleanConsumerSmoke(stage, meta, entries, distribution) {
  const entry = entries.find((item) => item.os === process.platform && item.cpu === process.arch);
  if (!entry) throw new Error(`no clean-consumer package for ${process.platform}/${process.arch}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-preflight-'));
  const cache = path.join(tmp, 'npm-cache');
  const platformArchive = distribution.platforms.find((item) => item.target === entry.directory);
  const packedRoot = path.resolve(stage, distribution.root.file);
  const packedPlatform = path.resolve(stage, platformArchive.file);
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  runNpm(npmArgs(cache, ['install', '--prefix', consumer, '--omit=optional', '--offline', packedRoot]), { cwd: tmp });
  runNpm(npmArgs(cache, ['install', '--prefix', consumer, '--offline', packedPlatform]), { cwd: tmp });
  const wrapper = path.join(consumer, 'node_modules', '@dztabel', 'researchkit', 'bin', 'research-kit.js');
  const version = run(process.execPath, [wrapper, '--version'], { cwd: consumer, env: cleanEnvironment() }).trim();
  const expectedVersion = `research-kit ${readJson(path.join(root, 'package.json')).version}`;
  if (version !== expectedVersion) throw new Error(`ResearchKit executable identity mismatch: expected version output ${expectedVersion}, found ${version || '<empty>'}`);
  const help = run(process.execPath, [wrapper, '--help'], { cwd: consumer, env: cleanEnvironment() }).trim();
  if (!/ResearchKit CLI core/.test(help)) throw new Error('ResearchKit executable identity mismatch: help marker missing');
  return { ok: true, target: entry.directory, version };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.stage) throw new Error('usage: release-preflight --stage <staging-dir> [--host-only] [--skip-consumer-smoke]');
  const stage = path.resolve(args.stage);
  const rootPackage = readJson(path.join(root, 'package.json'));
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const entries = selectedEntries(meta, args['host-only']);
  validateMetadata(rootPackage, meta);
  const release = validateStage(stage, meta, entries, rootPackage);
  if (!args['verify-packages']) {
    release.distribution = packageDistribution(stage, entries, rootPackage);
    fs.writeFileSync(path.join(stage, 'release-metadata.json'), `${JSON.stringify(release, null, 2)}\n`);
  }
  verifyDistribution(stage, release, entries, rootPackage);
  const cleanConsumer = args['skip-consumer-smoke'] ? { ok: false, skipped: true } : cleanConsumerSmoke(stage, meta, entries, release.distribution);
  console.log(JSON.stringify({
    ok: true,
    version: rootPackage.version,
    package_count: entries.length,
    clean_consumer: cleanConsumer,
    distribution: release.distribution
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`release preflight failed: ${error.message}`);
  process.exit(1);
}
