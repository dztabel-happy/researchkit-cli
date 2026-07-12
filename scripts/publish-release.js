#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function run(args, options = {}) {
  const result = childProcess.spawnSync('npm', args, { encoding: 'utf8', stdio: options.stdio || 'pipe' });
  if (result.error) throw result.error;
  return result;
}

function main() {
  const stageFlag = process.argv.indexOf('--stage');
  if (stageFlag < 0 || !process.argv[stageFlag + 1]) throw new Error('Usage: publish-release.js --stage <verified-stage>');
  const stage = path.resolve(process.argv[stageFlag + 1]);
  const release = JSON.parse(fs.readFileSync(path.join(stage, 'release-metadata.json'), 'utf8'));
  const descriptors = [...release.distribution.platforms, release.distribution.root];
  const verified = descriptors.map((descriptor) => {
    const tarball = path.resolve(stage, descriptor.file);
    const relative = path.relative(path.join(stage, 'packages'), tarball);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(tarball) !== '.tgz') {
      throw new Error(`Unsafe release package path: ${descriptor.file}`);
    }
    const data = fs.readFileSync(tarball);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const integrity = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
    if (descriptor.sha256 !== sha256 || descriptor.integrity !== integrity || descriptor.size !== data.length) {
      throw new Error(`Release package checksum mismatch or integrity/size mismatch: ${descriptor.file}`);
    }
    return { descriptor, tarball };
  });

  for (const { descriptor, tarball } of verified) {
    const packageId = `${descriptor.package}@${release.version}`;
    const existing = run(['view', packageId, 'dist.integrity', '--json']);
    if (existing.status === 0) {
      if (JSON.parse(existing.stdout) !== descriptor.integrity) throw new Error(`Registry integrity mismatch: ${packageId}`);
      process.stdout.write(`${packageId} already published; skipping.\n`);
      continue;
    }
    const published = run(['publish', tarball, '--access', 'public', '--provenance'], { stdio: 'inherit' });
    if (published.status !== 0) process.exit(published.status || 1);
  }
}

try {
  main();
} catch (error) {
  console.error(`release publish failed: ${error.message}`);
  process.exit(1);
}
