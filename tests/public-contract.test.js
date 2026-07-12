'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installNativeFixture } = require('./helpers/native-fixtures');

const root = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8'
  });
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RESEARCHKIT_')) delete env[key];
  }
  return { ...env, ...extra };
}

function npmArgs(cache, args) {
  return [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--userconfig', '/dev/null'];
}

function createCleanPublicCopy(tmp) {
  const publicRoot = path.join(tmp, 'public-clean');
  fs.cpSync(root, publicRoot, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules'].includes(path.basename(source))
  });
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']
  ]) {
    const result = run('git', args, { cwd: publicRoot });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return publicRoot;
}

function packRoot(tmp) {
  const cache = path.join(tmp, 'npm-cache');
  const packed = run('npm', npmArgs(cache, ['pack', '--json', '--pack-destination', tmp]), { cwd: root });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const result = JSON.parse(packed.stdout)[0];
  return { tarball: path.join(tmp, result.filename), files: result.files.map((file) => file.path) };
}

function installRoot(tmp) {
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  const packed = packRoot(tmp);
  const installed = run('npm', npmArgs(path.join(tmp, 'npm-cache'), [
    'install', '--prefix', consumer, '--omit=optional', '--offline', packed.tarball
  ]), { cwd: tmp });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  return {
    consumer,
    wrapper: path.join(consumer, 'node_modules', '@dztabel', 'researchkit', 'bin', 'research-kit.js'),
    files: packed.files
  };
}

function matchingPlatform(meta) {
  return meta.platform_packages.find((entry) => entry.os === process.platform && entry.cpu === process.arch);
}

test('root and platform package metadata stay in lockstep', () => {
  const rootPackage = readJson(path.join(root, 'package.json'));
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const repository = { type: 'git', url: 'https://github.com/dztabel-happy/researchkit-cli.git' };
  const expected = Object.fromEntries(meta.platform_packages.map((entry) => [entry.package, rootPackage.version]));
  assert.deepEqual(rootPackage.optionalDependencies, expected);
  assert.deepEqual(rootPackage.repository, repository);
  assert.equal(rootPackage.license, 'UNLICENSED');
  assert.equal(rootPackage.files.includes('LICENSE'), false);

  for (const entry of meta.platform_packages) {
    assert.equal(entry.version, rootPackage.version);
    assert.equal(entry.directory, `${entry.os}-${entry.cpu}`);
    const binary = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
    assert.equal(entry.artifact, `platforms/${entry.directory}/${binary}`);
    const template = readJson(path.join(root, 'platform-packages', entry.directory, 'package.json'));
    assert.equal(template.name, entry.package);
    assert.equal(template.version, rootPackage.version);
    assert.deepEqual(template.os, [entry.os]);
    assert.deepEqual(template.cpu, [entry.cpu]);
    assert.equal(template.bin['research-kit'], binary);
    assert.equal(template.private, true);
    assert.deepEqual(template.repository, repository);
    assert.equal(template.license, 'UNLICENSED');
    assert.equal(template.files.includes('LICENSE'), false);
  }
});

test('packed consumer ignores private-core fallbacks unless development mode is explicit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-consumer-'));
  const { consumer, wrapper } = installRoot(tmp);
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const platform = matchingPlatform(meta);
  assert.ok(platform, `test host ${process.platform}/${process.arch} needs platform metadata`);

  const privateRoot = path.join(consumer, 'node_modules', '@dztabel', 'researchkit-cli-core');
  write(path.join(privateRoot, 'package.json'), JSON.stringify({
    name: '@dztabel/researchkit-cli-core', version: '0.1.0', private: true
  }));
  const privateBin = path.join(privateRoot, 'bin', 'research-kit.js');
  write(privateBin, "#!/usr/bin/env node\nconsole.log('PRIVATE_CORE_FALLBACK_USED');\n", 0o755);

  const normal = run(process.execPath, [wrapper, '--help'], {
    cwd: consumer,
    env: cleanEnv({ RESEARCHKIT_DEV_MODE: '0' })
  });
  assert.equal(normal.status, 1, normal.stdout + normal.stderr);
  assert.match(normal.stderr, new RegExp(`Required ResearchKit platform package is missing: ${platform.package.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${platform.version}`));
  assert.doesNotMatch(normal.stdout, /PRIVATE_CORE_FALLBACK_USED/);

  const development = run(process.execPath, [wrapper, '--help'], {
    cwd: consumer,
    env: cleanEnv({ RESEARCHKIT_DEV_MODE: '1', RESEARCHKIT_CORE_BIN: privateBin })
  });
  assert.equal(development.status, 0, development.stderr);
  assert.match(development.stdout, /PRIVATE_CORE_FALLBACK_USED/);
});

test('malformed matching platform package reports the exact contract error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-malformed-'));
  const { consumer, wrapper } = installRoot(tmp);
  const rootPackage = readJson(path.join(root, 'package.json'));
  const platform = matchingPlatform(readJson(path.join(root, 'platform', 'packages.json')));
  assert.ok(platform);

  const packageRoot = path.join(consumer, 'node_modules', ...platform.package.split('/'));
  write(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: platform.package,
    version: rootPackage.version
  }));
  const result = run(process.execPath, [wrapper, '--help'], { cwd: consumer, env: cleanEnv() });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`Malformed ResearchKit platform package ${platform.package.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${rootPackage.version}: missing bin.research-kit`));
});

test('Skill metadata, UI metadata, and Plugin manifest are installable contracts', () => {
  const rootPackage = readJson(path.join(root, 'package.json'));
  const skill = fs.readFileSync(path.join(root, 'skills', 'deep-research-report', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: deep-research-report\ndescription: .+\n---\n/);
  assert.match(skill, /ReportKit `0\.1\.30\+ \/ cli-contract 0\.2`/);
  assert.match(skill, /DocxKit `0\.1\.55\+ \/ cli-contract 0\.2`/);
  assert.match(skill, /ChartKit `0\.1\.49\+`/);
  assert.match(skill, /absolute input and output paths/);
  assert.match(skill, /input_sha256/);
  assert.match(skill, /docx_sha256.*report_sha256/);
  assert.match(skill, /qa-status=not_run/);

  const agent = fs.readFileSync(path.join(root, 'skills', 'deep-research-report', 'agents', 'openai.yaml'), 'utf8');
  assert.match(agent, /display_name: "Deep Research Report"/);
  assert.match(agent, /default_prompt: ".*\$deep-research-report.*"/);

  const plugin = readJson(path.join(root, '.codex-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'researchkit');
  assert.equal(plugin.version, rootPackage.version);
  assert.equal(plugin.license, rootPackage.license);
  assert.equal(plugin.skills, './skills/');
  assert.ok(plugin.author.name);
  assert.ok(plugin.interface.displayName);
  assert.ok(plugin.interface.defaultPrompt.length > 0);
});

test('local marketplace installs the checkout in an isolated Codex home', () => {
  const rootPackage = readJson(path.join(root, 'package.json'));
  const marketplace = readJson(path.join(root, '.agents', 'plugins', 'marketplace.json'));
  assert.equal(marketplace.name, 'researchkit');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, 'researchkit');
  assert.deepEqual(entry.source, { source: 'local', path: '.' });
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.ok(entry.category);
  assert.ok(rootPackage.files.includes('.agents/plugins/marketplace.json'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-marketplace-'));
  assert.ok(packRoot(tmp).files.includes('.agents/plugins/marketplace.json'));
  const codexHome = path.join(tmp, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const env = { ...process.env, CODEX_HOME: codexHome };
  const addMarketplace = run('codex', ['plugin', 'marketplace', 'add', root, '--json'], { env });
  assert.equal(addMarketplace.status, 0, addMarketplace.stderr || addMarketplace.stdout);
  const addPlugin = run('codex', ['plugin', 'add', 'researchkit@researchkit', '--json'], { env });
  assert.equal(addPlugin.status, 0, addPlugin.stderr || addPlugin.stdout);

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /\/plugins/);
  assert.match(readme, /codex plugin marketplace add "\$PWD"/);
  assert.match(readme, /codex plugin marketplace add dztabel-happy\/researchkit-cli/);
  assert.match(readme, /npm install --global @dztabel\/researchkit/);
  assert.doesNotMatch(readme, /not published to npm/i);
  assert.doesNotMatch(readme, /resolves the Plugin from .*public npm registry/);
});

test('Skill records independent evidence review through the CLI-owned review entity', () => {
  const files = [
    'README.md',
    'examples/basic/README.md',
    'skills/deep-research-report/SKILL.md'
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  for (const text of files) {
    assert.match(text, /record-subagent[\s\\]+--role independent_evidence_review/);
    assert.match(text, /--evidence-ids/);
    assert.match(text, /--result (?:confirmed|<confirmed\|disputed>)/);
    assert.match(text, /--summary/);
    assert.match(text, /reviewed_input_sha256/);
  }
  const skill = files[2];
  assert.doesNotMatch(skill, /^\s*- `verification_(?:method|status)`/m);
  assert.match(skill, /Do not write .*verification_method.*verification_status.*verified_by/i);
});

test('public workflow records only material claims through digest-bound citation review', () => {
  for (const file of ['README.md', 'examples/basic/README.md', 'skills/deep-research-report/SKILL.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /claims\.json/);
    assert.match(text, /--role claim_citation_review/);
    assert.match(text, /--claim-ids/);
  }
  const skill = fs.readFileSync(path.join(root, 'skills', 'deep-research-report', 'SKILL.md'), 'utf8');
  assert.match(skill, /key\/material claim/i);
  assert.match(skill, /not ordinary prose/i);
  assert.doesNotMatch(skill, /every (?:sentence|claim).*claims\.json/i);
});

test('every documented external delivery package uses pack --external', () => {
  for (const file of ['README.md', 'examples/basic/README.md', 'skills/deep-research-report/SKILL.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const calls = [...text.matchAll(/research-kit pack[^\n`]*/g)].map((match) => match[0]);
    assert.ok(calls.length > 0, `${file} must document external packaging`);
    for (const call of calls) assert.match(call, /--external/, `${file}: ${call}`);
  }
});

test('Skill completion lifecycle compiles, audits, confirms, approves, then finalizes', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'deep-research-report', 'SKILL.md'), 'utf8');
  const section = skill.match(/## Completion lifecycle\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(section, 'Skill must define one authoritative Completion lifecycle section');
  const steps = [
    'research-kit build-md --merge-sections',
    'research/claims.json',
    '--role claim_citation_review',
    'research-kit check-claims',
    'research-kit build-md --voice-pass',
    'research-kit build-md --from-draft',
    'research-kit audit',
    'explicitly confirms',
    'research-kit approve --by',
    'research-kit finalize'
  ];
  let previous = -1;
  for (const step of steps) {
    const index = section[1].indexOf(step);
    assert.ok(index > previous, `${step} must appear in lifecycle order`);
    previous = index;
  }
});

test('Skill and public docs preserve stable evidence footnotes until compilation', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'deep-research-report', 'SKILL.md'), 'utf8');
  const voice = fs.readFileSync(path.join(root, 'skills', 'deep-research-report', 'references', 'voice-pass-zh.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const example = fs.readFileSync(path.join(root, 'examples', 'basic', 'README.md'), 'utf8');
  for (const text of [skill, voice, readme, example]) assert.match(text, /\[\^ev_001\]/);
  assert.match(skill, /final\.md/);
  assert.match(skill, /\[\^1\]/);
  assert.match(skill, /deliverables\/report\.md/);
  assert.match(skill, /\[1\]/);
  assert.doesNotMatch(skill, /keep all `\[\^n\]`/);
  assert.doesNotMatch(skill, /绝不出现 ev_\*/);
});

test('release staging preserves mode, writes checksums, and passes clean-consumer preflight', { timeout: 180000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-release-'));
  const publicRoot = createCleanPublicCopy(tmp);
  const stageScript = path.join(publicRoot, 'scripts', 'stage-release.js');
  const preflightScript = path.join(publicRoot, 'scripts', 'release-preflight.js');
  assert.ok(fs.existsSync(stageScript), 'missing scripts/stage-release.js');
  assert.ok(fs.existsSync(preflightScript), 'missing scripts/release-preflight.js');

  const artifacts = path.join(tmp, 'artifacts');
  const staged = path.join(tmp, 'staged');
  const meta = readJson(path.join(root, 'platform', 'packages.json'));
  const buildMetadata = {
    schema_version: '1.0.0',
    version: readJson(path.join(root, 'package.json')).version,
    kind: 'native_executable',
    native_binary: true,
    ok: true,
    source_commit: 'a'.repeat(40),
    source_dirty: false,
    targets: []
  };
  for (const entry of meta.platform_packages) {
    const artifact = path.join(artifacts, entry.artifact);
    installNativeFixture(entry, artifact);
    const binaryRel = entry.os === 'win32' ? 'bin/research-kit.exe' : 'bin/research-kit';
    const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    write(path.join(artifacts, 'platforms', entry.directory, 'SHA256SUMS'), `${digest}  ${binaryRel}\n`);
    const bunOs = entry.os === 'win32' ? 'windows' : entry.os;
    const baseline = ['linux', 'win32'].includes(entry.os) ? '-baseline' : '';
    buildMetadata.targets.push({
      target: `bun-${bunOs}-${entry.cpu}${baseline}`,
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
  write(path.join(artifacts, 'build-metadata.json'), `${JSON.stringify(buildMetadata, null, 2)}\n`);

  for (const [field, value] of [
    ['kind', 'javascript_bundle'],
    ['native_binary', false],
    ['ok', false]
  ]) {
    const invalidMetadata = { ...buildMetadata, [field]: value };
    write(path.join(artifacts, 'build-metadata.json'), `${JSON.stringify(invalidMetadata, null, 2)}\n`);
    const rejected = run(process.execPath, [
      stageScript,
      '--artifacts', artifacts,
      '--output', staged
    ]);
    assert.notEqual(rejected.status, 0, `stage-release must reject build metadata with ${field}=${value}`);
    assert.match(rejected.stderr, new RegExp(field));
  }
  write(path.join(artifacts, 'build-metadata.json'), `${JSON.stringify(buildMetadata, null, 2)}\n`);

  const stage = run(process.execPath, [
    stageScript,
    '--artifacts', artifacts,
    '--output', staged
  ]);
  assert.equal(stage.status, 0, stage.stderr || stage.stdout);
  for (const entry of meta.platform_packages) {
    const packageRoot = path.join(staged, entry.directory);
    const packageJson = readJson(path.join(packageRoot, 'package.json'));
    const binaryRel = packageJson.bin['research-kit'];
    const binary = path.join(packageRoot, binaryRel);
    const checksums = readJson(path.join(packageRoot, 'checksums.json'));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    assert.equal(checksums.algorithm, 'sha256');
    assert.equal(checksums.files[binaryRel], digest);
    assert.equal(packageJson.private, undefined);
    assert.equal(packageJson.license, 'UNLICENSED');
    assert.equal(fs.existsSync(path.join(packageRoot, 'LICENSE')), false);
    if (entry.os !== 'win32') assert.notEqual(fs.statSync(binary).mode & 0o111, 0);
  }
  assert.equal(Object.hasOwn(readJson(path.join(staged, 'release-metadata.json')), 'binary_license'), false);

  const preflight = run(process.execPath, [preflightScript, '--stage', staged]);
  assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
  const result = JSON.parse(preflight.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.package_count, meta.platform_packages.length);
  assert.equal(result.clean_consumer.ok, true);

  const host = matchingPlatform(meta);
  const hostPackage = readJson(path.join(staged, host.directory, 'package.json'));
  fs.appendFileSync(path.join(staged, host.directory, hostPackage.bin['research-kit']), '\ntampered\n');
  const tampered = run(process.execPath, [preflightScript, '--stage', staged, '--skip-consumer-smoke']);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /checksum mismatch/);
});
