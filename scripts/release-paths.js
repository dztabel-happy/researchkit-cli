'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RELEASE_OUTPUT_MARKER = '.researchkit-release-output';
const RELEASE_OUTPUT_MARKER_CONTENT = 'ResearchKit release output\n';

function canonicalPath(file) {
  let cursor = path.resolve(file);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return path.join(base, ...suffix);
}

function isSameOrAncestor(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  return isSameOrAncestor(left, right) || isSameOrAncestor(right, left);
}

function validateOutputPath(output, artifacts, publicRoot, home) {
  const unsafe = output === path.parse(output).root
    || isSameOrAncestor(output, home)
    || overlaps(output, publicRoot)
    || overlaps(output, artifacts);
  if (unsafe) throw new Error(`unsafe release output path: ${output}`);
}

function assertReleaseOutputOwned(output) {
  let stat;
  try {
    stat = fs.lstatSync(output);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  const marker = path.join(output, RELEASE_OUTPUT_MARKER);
  const owned = stat.isDirectory()
    && !stat.isSymbolicLink()
    && fs.existsSync(marker)
    && fs.lstatSync(marker).isFile()
    && fs.readFileSync(marker, 'utf8') === RELEASE_OUTPUT_MARKER_CONTENT;
  if (!owned) throw new Error(`release output is not owned by ResearchKit (marker missing or invalid): ${output}`);
}

function writeReleaseOutputMarker(output) {
  fs.writeFileSync(path.join(output, RELEASE_OUTPUT_MARKER), RELEASE_OUTPUT_MARKER_CONTENT, 'utf8');
}

module.exports = {
  RELEASE_OUTPUT_MARKER,
  RELEASE_OUTPUT_MARKER_CONTENT,
  canonicalPath,
  validateOutputPath,
  assertReleaseOutputOwned,
  writeReleaseOutputMarker
};
