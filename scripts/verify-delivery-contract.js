'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const contractRoot = path.join(projectRoot, 'contracts', 'delivery', '0.2');
const manifestPath = path.join(contractRoot, 'contract.json');
const requiredFiles = [
  'assets/chart-manifest.json',
  'assets/chart.png',
  'delivery-manifest.json',
  'report.md'
];

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest();
}

function listFiles(directory, current = directory) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(directory, absolute));
    } else {
      files.push(path.relative(directory, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

function validateManifest(manifest) {
  if (manifest.contract_version !== '0.2') throw new Error('contract version must be 0.2');
  if (!Array.isArray(manifest.files)) throw new Error('contract files must be an array');
  if (!/^[a-f0-9]{64}$/.test(manifest.aggregate_sha256 || '')) {
    throw new Error('aggregate_sha256 must be a lowercase SHA-256 digest');
  }

  const expected = manifest.files.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('each contract file must contain path and sha256');
    }
    if (entry.path === '' || entry.path.includes('\\') || path.posix.isAbsolute(entry.path) || path.posix.normalize(entry.path) !== entry.path) {
      throw new Error(`invalid contract path: ${entry.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid SHA-256 digest: ${entry.path}`);
    }
    return entry;
  });

  const names = expected.map((entry) => entry.path);
  if (new Set(names).size !== names.length || names.some((name, index) => name !== [...names].sort()[index])) {
    throw new Error('contract files must be unique and sorted');
  }
  if (names.some((name, index) => name !== requiredFiles[index]) || names.length !== requiredFiles.length) {
    throw new Error('contract files must exactly match delivery contract 0.2');
  }
  return expected;
}

function validateDeliveryManifest(canonicalBytes) {
  const delivery = JSON.parse(canonicalBytes.get('delivery-manifest.json').toString('utf8'));
  if (delivery.schema_version !== '1.1.0' || delivery.contract_version !== '0.2') {
    throw new Error('delivery manifest version mismatch');
  }
  if (typeof delivery.project_id !== 'string' || delivery.project_id === '' || !Number.isInteger(delivery.revision) || delivery.revision < 1 || typeof delivery.generated_at !== 'string' || delivery.generated_at === '') {
    throw new Error('delivery manifest identity is invalid');
  }
  const reportDigest = sha256(canonicalBytes.get('report.md')).toString('hex');
  if (delivery.input?.report_sha256 !== reportDigest) throw new Error('delivery manifest report_sha256 mismatch');
  for (const field of ['draft_sha256', 'final_sha256']) {
    if (delivery.input?.[field] !== null && !/^[a-f0-9]{64}$/.test(delivery.input?.[field] || '')) {
      throw new Error(`delivery manifest ${field} is invalid`);
    }
  }
  if (!Array.isArray(delivery.citations) || delivery.citations.length !== 1) {
    throw new Error('delivery manifest must contain one citation');
  }
  const exhibitTypes = Array.isArray(delivery.exhibits) ? delivery.exhibits.map((entry) => entry.type).sort() : [];
  if (exhibitTypes.length !== 2 || exhibitTypes[0] !== 'fig' || exhibitTypes[1] !== 'tbl') {
    throw new Error('delivery manifest must contain figure and table exhibits');
  }
  if (!Array.isArray(delivery.exports) || delivery.exports.length !== 0) {
    throw new Error('delivery manifest exports must be empty');
  }
}

function verifyFileSet(label, directory, expectedFiles, ignored = []) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label}: missing directory ${directory}`);
  }
  const ignoredFiles = new Set(ignored);
  const actualFiles = listFiles(directory).filter((relative) => !ignoredFiles.has(relative));
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const missing = expectedFiles.filter((relative) => !actualSet.has(relative));
  const extra = actualFiles.filter((relative) => !expectedSet.has(relative));
  const problems = [];
  if (missing.length) problems.push(`missing files: ${missing.join(', ')}`);
  if (extra.length) problems.push(`extra files: ${extra.join(', ')}`);
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
}

function verifyCanonical() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = validateManifest(manifest);
  const expectedFiles = expected.map((entry) => entry.path);
  verifyFileSet('canonical contract', contractRoot, expectedFiles, ['contract.json']);

  const aggregate = crypto.createHash('sha256');
  const canonicalBytes = new Map();
  for (const entry of expected) {
    const contents = fs.readFileSync(path.join(contractRoot, entry.path));
    const digest = sha256(contents);
    if (digest.toString('hex') !== entry.sha256) throw new Error(`digest mismatch: ${entry.path}`);
    aggregate.update(entry.path, 'utf8');
    aggregate.update(Buffer.from([0]));
    aggregate.update(digest);
    canonicalBytes.set(entry.path, contents);
  }
  if (aggregate.digest('hex') !== manifest.aggregate_sha256) throw new Error('aggregate digest mismatch');
  validateDeliveryManifest(canonicalBytes);
  return { manifest, expectedFiles, canonicalBytes };
}

function verifyCopy(directory, expectedFiles, canonicalBytes) {
  const absolute = path.resolve(directory);
  verifyFileSet(`copy ${absolute}`, absolute, expectedFiles);
  for (const relative of expectedFiles) {
    const contents = fs.readFileSync(path.join(absolute, relative));
    if (!contents.equals(canonicalBytes.get(relative))) throw new Error(`copy ${absolute}: content mismatch: ${relative}`);
  }
}

function parseCopies(args) {
  const copies = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--copy' || !args[index + 1] || args[index + 1] === '--copy') {
      throw new Error('usage: node scripts/verify-delivery-contract.js [--copy <dir>]...');
    }
    copies.push(args[index + 1]);
    index += 1;
  }
  return copies;
}

try {
  const copies = parseCopies(process.argv.slice(2));
  const { manifest, expectedFiles, canonicalBytes } = verifyCanonical();
  for (const directory of copies) verifyCopy(directory, expectedFiles, canonicalBytes);
  process.stdout.write(`Verified delivery contract ${manifest.contract_version} and ${copies.length} downstream copies.\n`);
} catch (error) {
  process.stderr.write(`Delivery contract verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
