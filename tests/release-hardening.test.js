'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installNativeFixture } = require('./helpers/native-fixtures');
const { matchesMachO, matchesElfX64, matchesPeX64 } = require('../scripts/native-binary');

const root = path.resolve(__dirname, '..');
const coreRoot = path.resolve(root, '..', 'researchkit-cli-core');
const stageScript = path.join(root, 'scripts', 'stage-release.js');
const preflightScript = path.join(root, 'scripts', 'release-preflight.js');
const publishScript = path.join(root, 'scripts', 'publish-release.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8'
  });
}

function write(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

function tarText(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function readTarEntries(tarball) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarball));
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const size = Number.parseInt(tarText(header, 124, 12) || '0', 8);
    const start = offset + 512;
    const end = start + size;
    const type = header[156];
    if (type === 0 || type === 48) {
      entries.push({
        name: prefix ? `${prefix}/${name}` : name,
        mode: Number.parseInt(tarText(header, 100, 8) || '0', 8),
        data: Buffer.from(archive.subarray(start, end))
      });
    }
    offset = start + (Math.ceil(size / 512) * 512);
  }
  return entries;
}

function writeTarNumber(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function writeTarEntries(tarball, entries) {
  const parts = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    writeTarNumber(header, 100, 8, entry.mode);
    writeTarNumber(header, 108, 8, 0);
    writeTarNumber(header, 116, 8, 0);
    writeTarNumber(header, 124, 12, entry.data.length);
    writeTarNumber(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = entry.type === undefined ? 48 : entry.type;
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    parts.push(header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  fs.writeFileSync(tarball, zlib.gzipSync(Buffer.concat(parts)));
}

function forgedNativeHeader(entry, cpu = entry.cpu) {
  if (entry.os === 'darwin') {
    const buffer = Buffer.alloc(160);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(cpu === 'arm64' ? 0x0100000c : 0x01000007, 4);
    buffer.writeUInt32LE(2, 12);
    buffer.writeUInt32LE(2, 16);
    buffer.writeUInt32LE(96, 20);
    buffer.writeUInt32LE(0x19, 32);
    buffer.writeUInt32LE(72, 36);
    buffer.writeBigUInt64LE(0n, 72);
    buffer.writeBigUInt64LE(BigInt(buffer.length), 80);
    buffer.writeUInt32LE(5, 88);
    buffer.writeUInt32LE(5, 92);
    buffer.writeUInt32LE(0x80000028, 104);
    buffer.writeUInt32LE(24, 108);
    buffer.writeBigUInt64LE(128n, 112);
    return buffer;
  }
  if (entry.os === 'linux') {
    const buffer = Buffer.alloc(128);
    buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    buffer.writeUInt16LE(2, 16);
    buffer.writeUInt16LE(cpu === 'x64' ? 0x3e : 0xb7, 18);
    buffer.writeUInt32LE(1, 20);
    buffer.writeBigUInt64LE(0x400001n, 24);
    buffer.writeBigUInt64LE(64n, 32);
    buffer.writeUInt16LE(64, 52);
    buffer.writeUInt16LE(56, 54);
    buffer.writeUInt16LE(1, 56);
    buffer.writeUInt32LE(1, 64);
    buffer.writeUInt32LE(5, 68);
    buffer.writeBigUInt64LE(0n, 72);
    buffer.writeBigUInt64LE(0x400000n, 80);
    buffer.writeBigUInt64LE(0x400000n, 88);
    buffer.writeBigUInt64LE(BigInt(buffer.length), 96);
    buffer.writeBigUInt64LE(BigInt(buffer.length), 104);
    return buffer;
  }
  const buffer = Buffer.alloc(512);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'ascii');
  buffer.writeUInt16LE(cpu === 'x64' ? 0x8664 : 0x014c, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(112, 0x94);
  buffer.writeUInt16LE(0x22, 0x96);
  buffer.writeUInt16LE(0x20b, 0x98);
  buffer.writeUInt32LE(0x1000, 0xa8);
  buffer.writeUInt32LE(448, 0xd4);
  buffer.write('.text\0\0\0', 0x108, 'ascii');
  buffer.writeUInt32LE(64, 0x110);
  buffer.writeUInt32LE(0x1000, 0x114);
  buffer.writeUInt32LE(64, 0x118);
  buffer.writeUInt32LE(448, 0x11c);
  buffer.writeUInt32LE(0x60000020, 0x12c);
  return buffer;
}

function forgedFatMachO(cpu) {
  const buffer = Buffer.alloc(28);
  buffer.writeUInt32BE(0xcafebabe, 0);
  buffer.writeUInt32BE(1, 4);
  buffer.writeUInt32BE(cpu === 'arm64' ? 0x0100000c : 0x01000007, 8);
  buffer.writeUInt32BE(0x100, 16);
  buffer.writeUInt32BE(0x80, 20);
  return buffer;
}

function minimalNativeHeader(entry, cpu = entry.cpu) {
  if (entry.os === 'darwin') {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(cpu === 'arm64' ? 0x0100000c : 0x01000007, 4);
    buffer.writeUInt32LE(2, 12);
    return buffer;
  }
  if (entry.os === 'linux') {
    const buffer = Buffer.alloc(64);
    buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    buffer.writeUInt16LE(2, 16);
    buffer.writeUInt16LE(cpu === 'x64' ? 0x3e : 0xb7, 18);
    buffer.writeUInt32LE(1, 20);
    buffer.writeBigUInt64LE(1n, 24);
    buffer.writeUInt16LE(64, 52);
    return buffer;
  }
  const buffer = Buffer.alloc(0x98);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'ascii');
  buffer.writeUInt16LE(cpu === 'x64' ? 0x8664 : 0x014c, 0x84);
  return buffer;
}

function fatWithForgedSlice(meta) {
  const arm = meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64');
  const x64 = meta.platform_packages.find((entry) => entry.directory === 'darwin-x64');
  const validArmSlice = forgedNativeHeader(arm);
  const forgedX64Slice = minimalNativeHeader(x64);
  const header = Buffer.alloc(48);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0x0100000c, 8);
  header.writeUInt32BE(header.length, 16);
  header.writeUInt32BE(validArmSlice.length, 20);
  header.writeUInt32BE(0x01000007, 28);
  header.writeUInt32BE(header.length + validArmSlice.length, 36);
  header.writeUInt32BE(forgedX64Slice.length, 40);
  return Buffer.concat([header, validArmSlice, forgedX64Slice]);
}

function fatWithForgedHeaders(meta) {
  const arm = meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64');
  const x64 = meta.platform_packages.find((entry) => entry.directory === 'darwin-x64');
  const armSlice = forgedNativeHeader(arm);
  const x64Slice = forgedNativeHeader(x64);
  const header = Buffer.alloc(48);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0x0100000c, 8);
  header.writeUInt32BE(header.length, 16);
  header.writeUInt32BE(armSlice.length, 20);
  header.writeUInt32BE(0x01000007, 28);
  header.writeUInt32BE(header.length + armSlice.length, 36);
  header.writeUInt32BE(x64Slice.length, 40);
  return Buffer.concat([header, armSlice, x64Slice]);
}

function targetName(entry) {
  const osName = entry.os === 'win32' ? 'windows' : entry.os;
  const baseline = ['linux', 'win32'].includes(entry.os) ? '-baseline' : '';
  return `bun-${osName}-${entry.cpu}${baseline}`;
}

function makeReleaseInput(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-hardening-'));
  const artifacts = path.join(tmp, 'artifacts');
  const output = path.join(tmp, 'staged');
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const entries = options.entries || meta.platform_packages;
  const metadata = {
    schema_version: '1.0.0',
    version: readJson(path.join(root, 'package.json')).version,
    kind: 'native_executable',
    native_binary: true,
    ok: true,
    source_commit: 'b'.repeat(40),
    source_dirty: false,
    targets: []
  };
  for (const entry of entries) {
    const artifact = path.join(artifacts, entry.artifact);
    const override = options.binaries && options.binaries[entry.directory];
    if (override !== undefined) {
      write(artifact, override, 0o755);
    } else {
      installNativeFixture(entry, artifact);
    }
    const binaryRel = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
    const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    write(path.join(artifacts, 'platforms', entry.directory, 'SHA256SUMS'), `${digest}  ${binaryRel}\n`);
    metadata.targets.push({
      target: targetName(entry),
      os: entry.os,
      cpu: entry.cpu,
      key: entry.directory,
      artifact: entry.artifact,
      archive: null,
      sha256: digest,
      size: fs.statSync(artifact).size,
      smoke_ok: true
    });
  }
  write(path.join(artifacts, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return { tmp, artifacts, output, meta, metadata };
}

function saveMetadata(input) {
  write(path.join(input.artifacts, 'build-metadata.json'), `${JSON.stringify(input.metadata, null, 2)}\n`);
}

function updateArchiveDescriptor(descriptor, archive) {
  const data = fs.readFileSync(archive);
  descriptor.sha256 = crypto.createHash('sha256').update(data).digest('hex');
  descriptor.integrity = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
  descriptor.size = data.length;
}

function stage(input, extra = []) {
  return run(process.execPath, [
    input.stageScript || stageScript,
    '--artifacts', input.artifacts,
    '--output', input.output,
    ...extra
  ]);
}

function copyReleaseSurface(destination) {
  fs.cpSync(root, destination, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules'].includes(path.basename(source))
  });
}

function prepareCleanPublic(input) {
  const publicRoot = path.join(input.tmp, 'public-clean');
  copyReleaseSurface(publicRoot);
  for (const args of [
    ['init'],
    ['config', 'user.name', 'ResearchKit Tests'],
    ['config', 'user.email', 'researchkit-tests@example.invalid'],
    ['add', '.'],
    ['commit', '-m', 'test fixture']
  ]) {
    const result = run('git', args, { cwd: publicRoot, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  input.publicRoot = publicRoot;
  input.stageScript = path.join(publicRoot, 'scripts', 'stage-release.js');
  input.preflightScript = path.join(publicRoot, 'scripts', 'release-preflight.js');
  return input;
}

test('checked-in platform templates stay private while the public release workflow builds, attests, and publishes', () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  for (const entry of meta.platform_packages) {
    const template = readJson(path.join(root, 'platform-packages', entry.directory, 'package.json'));
    assert.equal(template.private, true, entry.directory);
    assert.equal(template.license, 'UNLICENSED', entry.directory);
    assert.equal(template.files.includes('LICENSE'), false, entry.directory);
  }
  const rootPackage = readJson(path.join(root, 'package.json'));
  assert.equal(rootPackage.license, 'UNLICENSED');
  assert.equal(rootPackage.files.includes('LICENSE'), false);

  assert.equal(fs.existsSync(path.join(coreRoot, '.github', 'workflows', 'native-release.yml')), false);
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const runner of ['macos-14', 'macos-15-intel', 'ubuntu-latest', 'windows-latest']) {
    assert.match(workflow, new RegExp(runner));
  }
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /core_ref:/);
  assert.match(workflow, /publish:/);
  assert.doesNotMatch(workflow, /binary_license_path|public_repository/);
  assert.match(workflow, /repository:\s*dztabel-happy\/researchkit-cli-core/);
  assert.match(workflow, /ssh-key:\s*\$\{\{ secrets\.CORE_CHECKOUT_SSH_KEY \}\}/);
  assert.doesNotMatch(workflow, /RESEARCHKIT_BINARY_LICENSE|LICENSE_FILE|--binary-license/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.core_ref \}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /expected_tag="v\$\{core_version\}"/);
  assert.match(workflow, /EVENT_REF_TYPE:\s*\$\{\{ github\.ref_type \}\}/);
  assert.match(workflow, /test "\$EVENT_REF_TYPE" = "tag"/);
  assert.match(workflow, /test "\$EVENT_REF_NAME" = "\$expected_tag"/);
  assert.match(workflow, /test "\$CORE_REF" = "\$expected_tag"/);
  assert.match(workflow, /test "\$public_version" = "\$core_version"/);
  assert.match(workflow, /git -C core rev-list -n 1 "\$expected_tag"/);
  assert.match(workflow, /git -C public rev-list -n 1 "\$expected_tag"/);
  assert.match(workflow, /public_sha:/);
  assert.match(workflow, /core_sha:/);
  assert.match(workflow, /needs\.prepare\.outputs\.public_sha/);
  assert.match(workflow, /needs\.prepare\.outputs\.core_sha/);
  assert.doesNotMatch(workflow, /npm ci --prefix core/);
  assert.doesNotMatch(workflow, /uses:\s*[^@\n]+@v\d/);
  assert.match(workflow, /^permissions:\s*\n\s*contents: read/m);
  assert.match(workflow, /^jobs:/m);
  assert.match(workflow, /release-stage:[\s\S]*permissions:\s*\n\s*contents: read\s*\n\s*id-token: write\s*\n\s*attestations: write/);
  assert.match(workflow, /chmod \+x formal-build\/platforms\/linux-x64\/bin\/research-kit/);
  assert.match(workflow, /scripts\/build-binary\.js/);
  assert.match(workflow, /researchkit-build\.log" 2>&1/);
  assert.match(workflow, /Native build failed before executable output\./);
  assert.match(workflow, /version_smoke=\$version_status help_smoke=\$help_status archive=\$archive_status no_bytecode=\$no_bytecode_status/);
  assert.doesNotMatch(workflow, /cat[^\n]*researchkit-build\.log/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /jq -s --arg core_sha/);
  assert.match(workflow, /\.source_commit != \$core_sha/);
  assert.doesNotMatch(workflow, /\.\[0\] \* \{targets:/);
  assert.match(workflow, /scripts\/stage-release\.js/);
  assert.match(workflow, /scripts\/release-preflight\.js/);
  assert.match(workflow, /scripts\/publish-release\.js/);
  assert.doesNotMatch(workflow, /release-preflight\.js[^\n]+--skip-consumer-smoke/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(workflow, /oven-sh\/setup-bun@[0-9a-f]{40}/);
  assert.match(workflow, /packages\/\*\.tgz/);
  assert.match(workflow, /formal-stage\/release-metadata\.json/);
  assert.match(workflow, /researchkit-preflight\.log/);
  assert.match(workflow, /Release preflight failed\. Run the private manual sweep for details\./);
  assert.doesNotMatch(workflow, /release-preflight\.js[^\n]*\|\s*tee/);
  assert.match(workflow, /tar -czf researchkit-native-release-stage\.tar\.gz formal-stage formal-preflight\.json/);
  assert.match(workflow, /path:\s*researchkit-native-release-stage\.tar\.gz/);
  assert.doesNotMatch(workflow, /^\s+formal-stage\/\s*$/m);
  assert.match(workflow, /NODE_AUTH_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /github\.event\.inputs\.publish == 'true'/);
  assert.doesNotMatch(workflow, /pytest|cat\s+core\/|upload-artifact[^\n]*core/i);

  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /oven-sh\/setup-bun@[0-9a-f]{40}/);

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /stage-release\.js[^\n]+--binary-license/);
  assert.match(readme, /stage-release\.js[^\n]+--host-only/);
  assert.match(readme, /release\.yml/);
  assert.match(readme, /CORE_CHECKOUT_SSH_KEY/);
  assert.match(readme, /public repository/i);
  const preflight = fs.readFileSync(preflightScript, 'utf8');
  assert.match(preflight, /process\.env\.ComSpec \|\| 'cmd\.exe'/);
  assert.match(preflight, /\['\/d', '\/s', '\/c', 'npm\.cmd', \.\.\.args\]/);
});

test('release publishing is idempotent and publishes platform packages before the root wrapper', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-publish-'));
  const stage = path.join(tmp, 'stage');
  const packages = path.join(stage, 'packages');
  const fakeBin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'npm.log');
  const version = readJson(path.join(root, 'package.json')).version;
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const platformInputs = meta.platform_packages.map((entry) => ({
    target: entry.directory,
    package: entry.package,
    file: `packages/${entry.directory}.tgz`
  }));
  for (const descriptor of platformInputs) write(path.join(stage, descriptor.file), descriptor.package);
  write(path.join(packages, 'root.tgz'), '@dztabel/researchkit');
  const describe = (input) => {
    const file = path.join(stage, input.file);
    const descriptor = { ...input };
    updateArchiveDescriptor(descriptor, file);
    return descriptor;
  };
  const platforms = platformInputs.map(describe);
  const rootDescriptor = describe({ package: '@dztabel/researchkit', file: 'packages/root.tgz' });
  write(path.join(stage, 'release-metadata.json'), `${JSON.stringify({
    version,
    distribution: {
      platforms,
      root: rootDescriptor
    }
  })}\n`);
  write(path.join(fakeBin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'view' && process.env.FAKE_NPM_INTEGRITIES) {
  const integrities = JSON.parse(process.env.FAKE_NPM_INTEGRITIES);
  process.stdout.write(JSON.stringify(integrities[process.argv[3]]));
  process.exit(0);
}
process.exit(process.argv[2] === 'view' ? 1 : 0);
`, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_NPM_LOG: log };

  const first = run(process.execPath, [publishScript, '--stage', stage], { env });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const published = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[0] === 'publish');
  assert.deepEqual(published.map((args) => path.basename(args[1])), [...platforms.map((item) => path.basename(item.file)), 'root.tgz']);
  assert.ok(published.every((args) => args.includes('--provenance') && args.includes('--access')));

  fs.writeFileSync(log, '');
  const integrities = Object.fromEntries([...platforms, rootDescriptor].map((descriptor) => [`${descriptor.package}@${version}`, descriptor.integrity]));
  const second = run(process.execPath, [publishScript, '--stage', stage], { env: { ...env, FAKE_NPM_INTEGRITIES: JSON.stringify(integrities) } });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).some((args) => args[0] === 'publish'), false);

  fs.writeFileSync(log, '');
  const mismatch = run(process.execPath, [publishScript, '--stage', stage], { env: { ...env, FAKE_NPM_INTEGRITIES: JSON.stringify({ ...integrities, [`${platforms[0].package}@${version}`]: 'sha512-wrong' }) } });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /registry integrity mismatch/i);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).some((args) => args[0] === 'publish'), false);

  fs.writeFileSync(log, '');
  fs.appendFileSync(path.join(stage, platforms[0].file), 'tamper');
  const tampered = run(process.execPath, [publishScript, '--stage', stage], { env });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /release package checksum mismatch or integrity\/size mismatch/i);
  assert.equal(fs.readFileSync(log, 'utf8'), '');
});

test('stage-release rejects an existing unmarked output without deleting its sentinel', () => {
  const input = makeReleaseInput();
  write(path.join(input.output, 'sentinel.txt'), 'preserve');

  const result = stage(input);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release output.*marker|owned/i);
  assert.equal(fs.readFileSync(path.join(input.output, 'sentinel.txt'), 'utf8'), 'preserve');
});

test('stage-release creates its ownership marker and permits rebuilding only that directory', () => {
  const input = makeReleaseInput();

  const first = stage(input);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(fs.readFileSync(path.join(input.output, '.researchkit-release-output'), 'utf8'), 'ResearchKit release output\n');
  write(path.join(input.output, 'replace-me.txt'), 'old');

  const second = stage(input);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.existsSync(path.join(input.output, 'replace-me.txt')), false);
  assert.equal(fs.readFileSync(path.join(input.output, '.researchkit-release-output'), 'utf8'), 'ResearchKit release output\n');
});

test('stage-release records the exact public source commit and dirty state', () => {
  const input = prepareCleanPublic(makeReleaseInput());

  const result = stage(input);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const release = readJson(path.join(input.output, 'release-metadata.json'));
  assert.match(release.public_source.commit, /^[0-9a-f]{40}$/);
  assert.equal(release.public_source.dirty, false);
  assert.equal(release.public_source.commit, run('git', ['rev-parse', 'HEAD'], { cwd: input.publicRoot }).stdout.trim());
});

test('stage-release classifies destructive and overlapping outputs without invoking cleanup', () => {
  const { canonicalPath, validateOutputPath } = require('../scripts/release-paths');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-output-safety-'));
  const artifacts = path.join(tmp, 'artifacts', 'input');
  const candidates = [
    path.parse(root).root,
    os.homedir(),
    root,
    path.dirname(root),
    artifacts,
    path.dirname(artifacts),
    path.join(artifacts, 'nested-output')
  ];

  for (const output of candidates) {
    assert.throws(() => validateOutputPath(
      canonicalPath(output),
      canonicalPath(artifacts),
      canonicalPath(root),
      canonicalPath(os.homedir())
    ), /unsafe release output path/, output);
  }
});

test('stage-release rejects metadata and template paths that escape staging before cleanup', () => {
  const directoryInput = makeReleaseInput();
  const directoryCopy = path.join(directoryInput.tmp, 'public-copy');
  copyReleaseSurface(directoryCopy);
  const directoryMetaFile = path.join(directoryCopy, 'platform', 'packages.json');
  const directoryMeta = readJson(directoryMetaFile);
  const entry = directoryMeta.platform_packages[0];
  const originalDirectory = entry.directory;
  entry.directory = '../escaped';
  write(directoryMetaFile, `${JSON.stringify(directoryMeta, null, 2)}\n`);
  fs.cpSync(
    path.join(directoryCopy, 'platform-packages', originalDirectory),
    path.join(directoryCopy, 'escaped'),
    { recursive: true }
  );
  directoryInput.metadata.targets.find((target) => target.key === originalDirectory).key = entry.directory;
  saveMetadata(directoryInput);
  fs.mkdirSync(path.join(directoryInput.artifacts, 'escaped'), { recursive: true });
  fs.cpSync(
    path.join(directoryInput.artifacts, 'platforms', originalDirectory, 'SHA256SUMS'),
    path.join(directoryInput.artifacts, 'escaped', 'SHA256SUMS')
  );
  const escapedManifest = path.resolve(directoryInput.output, '..', 'escaped', 'package.json');
  write(escapedManifest, 'preserve');
  const directoryResult = run(process.execPath, [
    path.join(directoryCopy, 'scripts', 'stage-release.js'),
    '--artifacts', directoryInput.artifacts,
    '--output', directoryInput.output
  ]);
  assert.notEqual(directoryResult.status, 0);
  assert.match(directoryResult.stderr, /platform directory metadata mismatch/);
  assert.equal(fs.readFileSync(escapedManifest, 'utf8'), 'preserve');

  const binaryInput = makeReleaseInput();
  const binaryCopy = path.join(binaryInput.tmp, 'public-copy');
  copyReleaseSurface(binaryCopy);
  const binaryEntry = binaryInput.meta.platform_packages[0];
  const templateFile = path.join(binaryCopy, 'platform-packages', binaryEntry.directory, 'package.json');
  const template = readJson(templateFile);
  const escapedBinaryRel = '../../outside-bin';
  template.bin['research-kit'] = escapedBinaryRel;
  write(templateFile, `${JSON.stringify(template, null, 2)}\n`);
  const artifact = path.join(binaryInput.artifacts, binaryEntry.artifact);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  write(path.join(binaryInput.artifacts, 'platforms', binaryEntry.directory, 'SHA256SUMS'), `${digest}  ${escapedBinaryRel}\n`);
  const escapedBinary = path.resolve(binaryInput.output, binaryEntry.directory, escapedBinaryRel);
  write(escapedBinary, 'preserve');
  const binaryResult = run(process.execPath, [
    path.join(binaryCopy, 'scripts', 'stage-release.js'),
    '--artifacts', binaryInput.artifacts,
    '--output', binaryInput.output
  ]);
  assert.notEqual(binaryResult.status, 0);
  assert.match(binaryResult.stderr, /platform template target mismatch/);
  assert.equal(fs.readFileSync(escapedBinary, 'utf8'), 'preserve');
});

test('stage-release requires artifacts and output before cleanup', () => {
  const input = makeReleaseInput();
  write(path.join(input.output, 'preserve.txt'), 'keep');
  const missing = run(process.execPath, [
    stageScript,
    '--artifacts', input.artifacts
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--output/);
  assert.equal(fs.readFileSync(path.join(input.output, 'preserve.txt'), 'utf8'), 'keep');
});

test('native parser rejects unverified entry commands and virtual-only entry bytes', () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const arm = meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64');
  const linux = meta.platform_packages.find((entry) => entry.directory === 'linux-x64');
  const windows = meta.platform_packages.find((entry) => entry.directory === 'win32-x64');

  const unixThread = forgedNativeHeader(arm);
  unixThread.writeUInt32LE(0x5, 104);
  unixThread.writeUInt32LE(1, 112);
  unixThread.writeUInt32LE(2, 116);
  assert.equal(matchesMachO(unixThread, 'arm64'), false);
  assert.equal(matchesMachO(fatWithForgedSlice(meta), 'arm64'), false);

  const bssEntry = forgedNativeHeader(linux);
  bssEntry.writeBigUInt64LE(0x1000n, 104);
  bssEntry.writeBigUInt64LE(0x400200n, 24);
  assert.equal(matchesElfX64(bssEntry), false);

  const virtualEntry = forgedNativeHeader(windows);
  virtualEntry.writeUInt32LE(0x1000, 0x110);
  virtualEntry.writeUInt32LE(0x1200, 0xa8);
  assert.equal(matchesPeX64(virtualEntry), false);
});

test('native parser rejects structurally valid forged headers without code payload', () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const arm = meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64');
  const linux = meta.platform_packages.find((entry) => entry.directory === 'linux-x64');
  const windows = meta.platform_packages.find((entry) => entry.directory === 'win32-x64');
  assert.equal(matchesMachO(forgedNativeHeader(arm), 'arm64'), false);
  assert.equal(matchesMachO(fatWithForgedHeaders(meta), 'arm64'), false);
  assert.equal(matchesElfX64(forgedNativeHeader(linux)), false);
  assert.equal(matchesPeX64(forgedNativeHeader(windows)), false);
});

test('stage-release rejects scripts and wrong native architectures before cleanup', () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const cases = [
    ['Node shebang', 'darwin-arm64', Buffer.from('#!/usr/bin/env node\nconsole.log("not native");\n')],
    ['forged Mach-O without code payload', 'darwin-arm64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'))],
    ['minimal Mach-O header', 'darwin-arm64', minimalNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'))],
    ['truncated Mach-O', 'darwin-arm64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64')).subarray(0, 8)],
    ['forged fat Mach-O', 'darwin-arm64', forgedFatMachO('arm64')],
    ['fat Mach-O with forged slice', 'darwin-arm64', fatWithForgedSlice(meta)],
    ['fat Mach-O with forged headers', 'darwin-arm64', fatWithForgedHeaders(meta)],
    ['Mach-O object', 'darwin-arm64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'));
      buffer.writeUInt32LE(1, 12);
      return buffer;
    })()],
    ['Mach-O without file-backed segment', 'darwin-arm64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'));
      buffer.writeBigUInt64LE(0n, 80);
      return buffer;
    })()],
    ['Mach-O without executable segment', 'darwin-arm64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'));
      buffer.writeUInt32LE(1, 92);
      return buffer;
    })()],
    ['Mach-O without LC_MAIN or LC_UNIXTHREAD', 'darwin-arm64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'));
      buffer.writeUInt32LE(1, 104);
      return buffer;
    })()],
    ['Mach-O with LC_UNIXTHREAD only', 'darwin-arm64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'));
      buffer.writeUInt32LE(0x5, 104);
      buffer.writeUInt32LE(1, 112);
      buffer.writeUInt32LE(2, 116);
      return buffer;
    })()],
    ['Mach-O x64 as arm64', 'darwin-arm64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-arm64'), 'x64')],
    ['Mach-O arm64 as x64', 'darwin-x64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'darwin-x64'), 'arm64')],
    ['forged ELF without code payload', 'linux-x64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'))],
    ['minimal ELF header', 'linux-x64', minimalNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'))],
    ['truncated ELF', 'linux-x64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64')).subarray(0, 20)],
    ['ELF object', 'linux-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'));
      buffer.writeUInt16LE(1, 16);
      return buffer;
    })()],
    ['ELF without file-backed executable segment', 'linux-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'));
      buffer.writeBigUInt64LE(0n, 96);
      return buffer;
    })()],
    ['ELF entry outside executable segment', 'linux-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'));
      buffer.writeBigUInt64LE(0x500000n, 24);
      return buffer;
    })()],
    ['ELF entry in virtual-only executable bytes', 'linux-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'));
      buffer.writeBigUInt64LE(0x1000n, 104);
      buffer.writeBigUInt64LE(0x400200n, 24);
      return buffer;
    })()],
    ['ELF arm64 as x64', 'linux-x64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'linux-x64'), 'arm64')],
    ['forged PE without code payload', 'win32-x64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'))],
    ['minimal PE header', 'win32-x64', minimalNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'))],
    ['truncated PE', 'win32-x64', (() => {
      const buffer = Buffer.alloc(0x86);
      buffer.write('MZ', 0, 'ascii');
      buffer.writeUInt32LE(0x80, 0x3c);
      buffer.write('PE\0\0', 0x80, 'ascii');
      buffer.writeUInt16LE(0x8664, 0x84);
      return buffer;
    })()],
    ['PE DLL', 'win32-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'));
      buffer.writeUInt16LE(buffer.readUInt16LE(0x96) | 0x2000, 0x96);
      return buffer;
    })()],
    ['PE without file-backed code section', 'win32-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'));
      buffer.writeUInt32LE(0, 0x118);
      return buffer;
    })()],
    ['PE entry outside executable section', 'win32-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'));
      buffer.writeUInt32LE(1, 0xa8);
      return buffer;
    })()],
    ['PE entry in virtual-only executable bytes', 'win32-x64', (() => {
      const buffer = forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'));
      buffer.writeUInt32LE(0x1000, 0x110);
      buffer.writeUInt32LE(0x1200, 0xa8);
      return buffer;
    })()],
    ['PE x86 as x64', 'win32-x64', forgedNativeHeader(meta.platform_packages.find((entry) => entry.directory === 'win32-x64'), 'x86')]
  ];

  for (const [name, target, binary] of cases) {
    const input = makeReleaseInput({ binaries: { [target]: binary } });
    write(path.join(input.output, 'preserve.txt'), 'keep');
    const result = stage(input);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /native binary format\/architecture mismatch/, `${name}: ${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(input.output, 'preserve.txt'), 'utf8'), 'keep');
  }
});

test('formal staging requires clean source provenance and smoke evidence for every target', () => {
  const cases = [
    ['source_commit', (input) => { delete input.metadata.source_commit; }],
    ['source_commit', (input) => { input.metadata.source_commit = 'not-a-commit'; }],
    ['source_dirty', (input) => { delete input.metadata.source_dirty; }],
    ['source_dirty', (input) => { input.metadata.source_dirty = true; }],
    ['smoke', (input) => { input.metadata.targets[1].smoke_ok = null; }],
    ['smoke', (input) => { delete input.metadata.targets[2].smoke_ok; }]
  ];

  for (const [message, mutate] of cases) {
    const input = makeReleaseInput();
    mutate(input);
    saveMetadata(input);
    const result = stage(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message), result.stderr);
  }
});

test('host-only staging remains available and release metadata is independently preflighted', { timeout: 60000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  const staged = stage(input, ['--host-only']);
  assert.equal(staged.status, 0, staged.stderr || staged.stdout);

  const packageJson = readJson(path.join(input.output, host.directory, 'package.json'));
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, 'UNLICENSED');
  assert.equal(fs.existsSync(path.join(input.output, host.directory, 'LICENSE')), false);
  const release = readJson(path.join(input.output, 'release-metadata.json'));
  assert.equal(Object.hasOwn(release, 'binary_license'), false);
  assert.equal(release.source_build.source_commit, 'b'.repeat(40));
  assert.equal(release.source_build.source_dirty, false);
  assert.equal(release.source_build.targets[0].smoke_ok, true);

  const preflight = run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only']);
  assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);

  const packagedRelease = readJson(path.join(input.output, 'release-metadata.json'));
  assert.equal(packagedRelease.public_source.dirty, false);
  assert.match(packagedRelease.distribution.root.sha256, /^[0-9a-f]{64}$/);
  assert.match(packagedRelease.distribution.root.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(packagedRelease.distribution.platforms.length, 1);
  for (const descriptor of [packagedRelease.distribution.root, ...packagedRelease.distribution.platforms]) {
    const archive = path.join(input.output, descriptor.file);
    assert.equal(fs.statSync(archive).size, descriptor.size);
    const data = fs.readFileSync(archive);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), descriptor.sha256);
    assert.equal(`sha512-${crypto.createHash('sha512').update(data).digest('base64')}`, descriptor.integrity);
  }

  release.source_build.source_dirty = true;
  write(path.join(input.output, 'release-metadata.json'), `${JSON.stringify(release, null, 2)}\n`);
  const rejected = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke'
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /source_dirty/);
});

test('preflight verify-packages rejects public commit drift and tampered root tarball', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  const packaged = run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']);
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  fs.appendFileSync(path.join(input.output, release.distribution.root.file), 'tamper');
  let result = run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke', '--verify-packages']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /distribution checksum mismatch/i);

  const clean = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(clean, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [clean.preflightScript, '--stage', clean.output, '--host-only', '--skip-consumer-smoke']).status, 0);
  const drifted = readJson(path.join(clean.output, 'release-metadata.json'));
  drifted.public_source.commit = 'f'.repeat(40);
  write(path.join(clean.output, 'release-metadata.json'), `${JSON.stringify(drifted, null, 2)}\n`);
  result = run(process.execPath, [clean.preflightScript, '--stage', clean.output, '--host-only', '--skip-consumer-smoke', '--verify-packages']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public source commit mismatch/i);
});

test('preflight binds every root package file to the public checkout bytes', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']).status, 0);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  const archive = path.join(input.output, release.distribution.root.file);
  const entries = readTarEntries(archive);
  const readme = entries.find((entry) => entry.name === 'package/README.md');
  assert.ok(readme);
  readme.data = Buffer.concat([readme.data, Buffer.from('\nforged\n')]);
  writeTarEntries(archive, entries);
  updateArchiveDescriptor(release.distribution.root, archive);
  write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

  const result = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke',
    '--verify-packages'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root package file mismatch: README\.md/i);
});

test('preflight rejects a platform tarball relabeled as the root package', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']).status, 0);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  const rootArchive = path.join(input.output, release.distribution.root.file);
  const platformArchive = path.join(input.output, release.distribution.platforms[0].file);
  fs.copyFileSync(platformArchive, rootArchive);
  updateArchiveDescriptor(release.distribution.root, rootArchive);
  write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

  const result = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke',
    '--verify-packages'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root package manifest mismatch/i);
});

test('preflight rejects a root tarball relabeled as a platform package', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']).status, 0);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  const rootArchive = path.join(input.output, release.distribution.root.file);
  const platformArchive = path.join(input.output, release.distribution.platforms[0].file);
  fs.copyFileSync(rootArchive, platformArchive);
  updateArchiveDescriptor(release.distribution.platforms[0], platformArchive);
  write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

  const result = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke',
    '--verify-packages'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /platform package manifest mismatch/i);
});

test('preflight rejects a replaced platform binary even when tarball descriptor and internal checksum are updated', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']).status, 0);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  const descriptor = release.distribution.platforms[0];
  const archive = path.join(input.output, descriptor.file);
  const binaryRel = host.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
  const entries = readTarEntries(archive);
  const binary = entries.find((entry) => entry.name === `package/${binaryRel}`);
  const checksums = entries.find((entry) => entry.name === 'package/checksums.json');
  assert.ok(binary);
  assert.ok(checksums);
  binary.data[0] ^= 1;
  const digest = crypto.createHash('sha256').update(binary.data).digest('hex');
  const checksumData = JSON.parse(checksums.data.toString('utf8'));
  checksumData.files[binaryRel] = digest;
  checksums.data = Buffer.from(`${JSON.stringify(checksumData, null, 2)}\n`);
  writeTarEntries(archive, entries);
  updateArchiveDescriptor(descriptor, archive);
  write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

  const result = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke',
    '--verify-packages'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /platform package binary (?:checksum|size) mismatch/i);
});

test('preflight rejects lifecycle-script injection with an updated root tarball descriptor', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']).status, 0);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  const descriptor = release.distribution.root;
  const archive = path.join(input.output, descriptor.file);
  const entries = readTarEntries(archive);
  const manifest = entries.find((entry) => entry.name === 'package/package.json');
  assert.ok(manifest);
  const packageJson = JSON.parse(manifest.data.toString('utf8'));
  packageJson.scripts.preinstall = 'node -e "process.exit(0)"';
  manifest.data = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`);
  writeTarEntries(archive, entries);
  updateArchiveDescriptor(descriptor, archive);
  write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

  const result = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke',
    '--verify-packages'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root package (?:manifest mismatch|install lifecycle script)/i);
});

test('preflight rejects unsupported tar members and invalid tar header checksums', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  assert.equal(stage(input, ['--host-only']).status, 0);
  assert.equal(run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only', '--skip-consumer-smoke']).status, 0);

  const releaseFile = path.join(input.output, 'release-metadata.json');
  const originalRelease = readJson(releaseFile);
  const archive = path.join(input.output, originalRelease.distribution.platforms[0].file);
  const originalArchive = fs.readFileSync(archive);
  const cases = [
    ['unsupported tar member', () => {
      const entries = readTarEntries(archive);
      entries.push({ name: 'package/extra-link', mode: 0o777, type: 50, linkname: 'package.json', data: Buffer.alloc(0) });
      writeTarEntries(archive, entries);
    }, /release archive entry type/i],
    ['invalid tar header checksum', () => {
      const bytes = zlib.gunzipSync(fs.readFileSync(archive));
      bytes[148] = bytes[148] === 48 ? 49 : 48;
      fs.writeFileSync(archive, zlib.gzipSync(bytes));
    }, /release archive header checksum/i]
  ];

  for (const [name, mutate, message] of cases) {
    fs.writeFileSync(archive, originalArchive);
    const release = JSON.parse(JSON.stringify(originalRelease));
    mutate();
    const descriptor = release.distribution.platforms[0];
    updateArchiveDescriptor(descriptor, archive);
    write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
    const result = run(process.execPath, [
      input.preflightScript,
      '--stage', input.output,
      '--host-only',
      '--skip-consumer-smoke',
      '--verify-packages'
    ]);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, message, `${name}: ${result.stderr}`);
  }
});

test('clean-consumer preflight rejects an unrelated native executable with successful help exit', { timeout: 120000 }, () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host], binaries: { [host.directory]: fs.readFileSync(process.execPath) } }));
  const staged = stage(input, ['--host-only']);
  assert.equal(staged.status, 0, staged.stderr || staged.stdout);

  const result = run(process.execPath, [input.preflightScript, '--stage', input.output, '--host-only']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ResearchKit executable identity|version output/i);
});

test('preflight binds staged bytes to source-build target digest and size', () => {
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const host = meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
  assert.ok(host);
  const input = prepareCleanPublic(makeReleaseInput({ entries: [host] }));
  const staged = stage(input, ['--host-only']);
  assert.equal(staged.status, 0, staged.stderr || staged.stdout);

  const packageDir = path.join(input.output, host.directory);
  const packageJson = readJson(path.join(packageDir, 'package.json'));
  const binaryRel = packageJson.bin['research-kit'];
  const binary = path.join(packageDir, binaryRel);
  fs.appendFileSync(binary, Buffer.from([0]));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const checksumsFile = path.join(packageDir, 'checksums.json');
  const checksums = readJson(checksumsFile);
  checksums.files[binaryRel] = digest;
  write(checksumsFile, `${JSON.stringify(checksums, null, 2)}\n`);
  const releaseFile = path.join(input.output, 'release-metadata.json');
  const release = readJson(releaseFile);
  release.packages[0].sha256 = digest;
  write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);

  const result = run(process.execPath, [
    input.preflightScript,
    '--stage', input.output,
    '--host-only',
    '--skip-consumer-smoke'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source build artifact (?:checksum|size) mismatch/);
});
