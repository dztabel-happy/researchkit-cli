#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const wrapper = path.resolve(__dirname, '..', 'bin', 'research-kit.js');
const result = childProcess.spawnSync(process.execPath, [wrapper, '--help'], {
  stdio: 'inherit',
  env: { ...process.env, RESEARCHKIT_DEV_MODE: '1' }
});
process.exit(result.status == null ? 1 : result.status);
