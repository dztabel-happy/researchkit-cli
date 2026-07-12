'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const verifier = path.join(root, 'scripts', 'verify-delivery-contract.js');
const contractRoot = path.join(root, 'contracts', 'delivery', '0.2');
const expectedFiles = [
  'assets/chart-manifest.json',
  'assets/chart.png',
  'delivery-manifest.json',
  'report.md'
];
const expectedHashes = {
  'assets/chart-manifest.json': 'c9200f1907079f2b37e1d36236b9fd1d5e6240683e91a9f2a3b9e14f57b8d9b5',
  'assets/chart.png': 'd42479ac5cbd451fdd2910b41804b0327785b67c676bb5a0704a5a8bb2df92d8',
  'delivery-manifest.json': 'eca37eaa3bb65981ca23af86c03168c08b70a3e7a97bb154e36ad6265606f20a',
  'report.md': 'c91ca003573a687be3825384d2fa4dbcbc82032e3a0016167e89a74ec5e1a21b'
};
const expectedAggregate = '571222eab082e924f4bb0c2e9a98bd472afa049c076b9ea9c5936ab2d34f3b86';
const expectedDeliveryManifest = {
  schema_version: '1.1.0',
  contract_version: '0.2',
  project_id: 'rk_delivery_contract_0_2',
  revision: 1,
  generated_at: '2026-07-10T00:00:00.000Z',
  input: {
    draft_sha256: null,
    final_sha256: null,
    report_sha256: expectedHashes['report.md']
  },
  citations: [{ number: 1, evidence_ids: ['ev_001'], source_ids: ['src_001'] }],
  exhibits: [
    {
      id: 'fig:annual_trend',
      type: 'fig',
      number: '1.1',
      caption: '年度趋势',
      asset: 'assets/chart.png',
      chart_manifest: 'assets/chart-manifest.json',
      evidence_ids: ['ev_001'],
      source_ids: ['src_001']
    },
    {
      id: 'tbl:method_comparison',
      type: 'tbl',
      number: '2.1',
      caption: '方法比较',
      asset: null,
      chart_manifest: null,
      evidence_ids: ['ev_001'],
      source_ids: ['src_001']
    }
  ],
  exports: []
};

function runVerifier(args = [], script = verifier) {
  return childProcess.spawnSync(process.execPath, [script, ...args], {
    cwd: path.dirname(path.dirname(script)),
    encoding: 'utf8'
  });
}

function copyPayload(destination) {
  for (const relative of expectedFiles) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(contractRoot, relative), target);
  }
}

function aggregateDigest(directory, files = expectedFiles) {
  const aggregate = crypto.createHash('sha256');
  for (const relative of files) {
    aggregate.update(relative, 'utf8');
    aggregate.update(Buffer.from([0]));
    aggregate.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, relative))).digest());
  }
  return aggregate.digest('hex');
}

test('canonical delivery contract 0.2 has the exact public payload and is packed', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(contractRoot, 'contract.json'), 'utf8'));
  assert.equal(manifest.contract_version, '0.2');
  assert.deepEqual(manifest.files.map((entry) => entry.path), expectedFiles);
  assert.deepEqual(Object.fromEntries(manifest.files.map((entry) => [entry.path, entry.sha256])), expectedHashes);
  assert.equal(manifest.aggregate_sha256, expectedAggregate);
  assert.equal(aggregateDigest(contractRoot), expectedAggregate);
  assert.equal(fs.existsSync(path.join(contractRoot, 'report.json')), false);

  const verification = runVerifier();
  assert.equal(verification.status, 0, verification.stderr || verification.stdout);

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(packageJson.files.includes('contracts/'));
  assert.ok(packageJson.files.includes('.gitattributes'));

  assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), [
    'contracts/delivery/0.2/contract.json text eol=lf',
    'contracts/delivery/0.2/delivery-manifest.json text eol=lf',
    'contracts/delivery/0.2/report.md text eol=lf',
    'contracts/delivery/0.2/assets/chart-manifest.json text eol=lf',
    'contracts/delivery/0.2/assets/chart.png binary',
    ''
  ].join('\n'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-contract-pack-'));
  const packed = childProcess.spawnSync('npm', [
    'pack', '--dry-run', '--json', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', path.join(tmp, 'npm-cache'), '--userconfig', '/dev/null'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const files = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path);
  assert.ok(files.includes('.gitattributes'));
  for (const relative of [...expectedFiles, 'contract.json']) {
    assert.ok(files.includes(`contracts/delivery/0.2/${relative}`), relative);
  }
});

test('canonical chart metadata matches the current ChartKit producer contract and report caption', () => {
  const chart = JSON.parse(fs.readFileSync(path.join(contractRoot, 'assets', 'chart-manifest.json'), 'utf8'));
  assert.equal(chart.contract_version, '0.1');
  assert.equal(chart.caption, '年度趋势');
});

test('delivery manifest binds the report and maps one citation plus figure and table exhibits', () => {
  const delivery = JSON.parse(fs.readFileSync(path.join(contractRoot, 'delivery-manifest.json'), 'utf8'));
  assert.deepEqual(delivery, expectedDeliveryManifest);
  assert.equal(
    delivery.input.report_sha256,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(contractRoot, 'report.md'))).digest('hex')
  );
});

test('verifier accepts one or more exact downstream copies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-contract-copy-'));
  const first = path.join(tmp, 'reportkit');
  const second = path.join(tmp, 'docxkit');
  copyPayload(first);
  copyPayload(second);

  const result = runVerifier(['--copy', first, '--copy', second]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('verifier rejects missing, extra, and drifted downstream files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-contract-reject-'));
  const missing = path.join(tmp, 'missing');
  copyPayload(missing);
  fs.rmSync(path.join(missing, 'delivery-manifest.json'));
  const missingResult = runVerifier(['--copy', missing]);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /missing files: delivery-manifest\.json/);

  const extra = path.join(tmp, 'extra');
  copyPayload(extra);
  fs.writeFileSync(path.join(extra, 'report.json'), '{}\n');
  const extraResult = runVerifier(['--copy', extra]);
  assert.notEqual(extraResult.status, 0);
  assert.match(extraResult.stderr, /extra files: report\.json/);

  const drifted = path.join(tmp, 'drifted');
  copyPayload(drifted);
  fs.appendFileSync(path.join(drifted, 'delivery-manifest.json'), '\n');
  const driftedResult = runVerifier(['--copy', drifted]);
  assert.notEqual(driftedResult.status, 0);
  assert.match(driftedResult.stderr, /content mismatch: delivery-manifest\.json/);
});

test('verifier requires the delivery manifest and its report digest binding', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-contract-required-'));
  const missingProject = path.join(tmp, 'missing-project');
  const missingScript = path.join(missingProject, 'scripts', 'verify-delivery-contract.js');
  fs.mkdirSync(path.dirname(missingScript), { recursive: true });
  fs.copyFileSync(verifier, missingScript);
  fs.cpSync(path.join(root, 'contracts'), path.join(missingProject, 'contracts'), { recursive: true });
  const missingRoot = path.join(missingProject, 'contracts', 'delivery', '0.2');
  const missingContractPath = path.join(missingRoot, 'contract.json');
  const missingContract = JSON.parse(fs.readFileSync(missingContractPath, 'utf8'));
  missingContract.files = missingContract.files.filter((entry) => entry.path !== 'delivery-manifest.json');
  fs.rmSync(path.join(missingRoot, 'delivery-manifest.json'), { force: true });
  missingContract.aggregate_sha256 = aggregateDigest(missingRoot, missingContract.files.map((entry) => entry.path));
  fs.writeFileSync(missingContractPath, `${JSON.stringify(missingContract, null, 2)}\n`);
  const missingResult = runVerifier([], missingScript);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /contract files must exactly match delivery contract 0\.2/);

  const driftProject = path.join(tmp, 'drift-project');
  const driftScript = path.join(driftProject, 'scripts', 'verify-delivery-contract.js');
  fs.mkdirSync(path.dirname(driftScript), { recursive: true });
  fs.copyFileSync(verifier, driftScript);
  fs.cpSync(path.join(root, 'contracts'), path.join(driftProject, 'contracts'), { recursive: true });
  const driftRoot = path.join(driftProject, 'contracts', 'delivery', '0.2');
  const deliveryPath = path.join(driftRoot, 'delivery-manifest.json');
  const delivery = JSON.parse(fs.readFileSync(deliveryPath, 'utf8'));
  delivery.input.report_sha256 = '0'.repeat(64);
  fs.writeFileSync(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`);
  const driftContractPath = path.join(driftRoot, 'contract.json');
  const driftContract = JSON.parse(fs.readFileSync(driftContractPath, 'utf8'));
  driftContract.files.find((entry) => entry.path === 'delivery-manifest.json').sha256 = crypto.createHash('sha256').update(fs.readFileSync(deliveryPath)).digest('hex');
  driftContract.aggregate_sha256 = aggregateDigest(driftRoot);
  fs.writeFileSync(driftContractPath, `${JSON.stringify(driftContract, null, 2)}\n`);
  const driftResult = runVerifier([], driftScript);
  assert.notEqual(driftResult.status, 0);
  assert.match(driftResult.stderr, /delivery manifest report_sha256 mismatch/);
});

test('verifier independently rejects canonical per-file and aggregate drift', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'researchkit-contract-canonical-'));
  const project = path.join(tmp, 'project');
  const script = path.join(project, 'scripts', 'verify-delivery-contract.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(verifier, script);
  fs.cpSync(path.join(root, 'contracts'), path.join(project, 'contracts'), { recursive: true });

  fs.appendFileSync(path.join(project, 'contracts', 'delivery', '0.2', 'assets', 'chart-manifest.json'), '\n');
  const perFile = runVerifier([], script);
  assert.notEqual(perFile.status, 0);
  assert.match(perFile.stderr, /digest mismatch: assets\/chart-manifest\.json/);

  fs.rmSync(path.join(project, 'contracts'), { recursive: true });
  fs.cpSync(path.join(root, 'contracts'), path.join(project, 'contracts'), { recursive: true });
  const manifestPath = path.join(project, 'contracts', 'delivery', '0.2', 'contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.aggregate_sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const aggregate = runVerifier([], script);
  assert.notEqual(aggregate.status, 0);
  assert.match(aggregate.stderr, /aggregate digest mismatch/);
});
