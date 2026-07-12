'use strict';

const fs = require('node:fs');

const MACH_CPU = {
  arm64: 0x0100000c,
  x64: 0x01000007
};

function readUInt32(buffer, offset, endian) {
  return endian === 'be' ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
}

function readUInt64(buffer, offset, endian) {
  const value = endian === 'be' ? buffer.readBigUInt64BE(offset) : buffer.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function hasCodePayload(buffer, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > buffer.length) return false;
  const bytes = buffer.subarray(start, Math.min(end, start + 64));
  if (bytes.length < 8 || bytes.every((byte) => byte === 0 || byte === 0x90 || byte === 0xcc)) return false;
  for (let period = 1; period <= Math.min(8, Math.floor(bytes.length / 2)); period += 1) {
    let repeated = true;
    for (let index = period; index < bytes.length; index += 1) {
      if (bytes[index] !== bytes[index % period]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return false;
  }
  return true;
}

function matchesThinMachO(buffer, cpu) {
  if (buffer.length < 32) return false;
  const expectedCpu = MACH_CPU[cpu];
  if (!expectedCpu) return false;

  let endian;
  if (buffer.readUInt32LE(0) === 0xfeedfacf) endian = 'le';
  else if (buffer.readUInt32BE(0) === 0xfeedfacf) endian = 'be';
  else return false;
  if (readUInt32(buffer, 4, endian) !== expectedCpu || readUInt32(buffer, 12, endian) !== 2) return false;

  const commandCount = readUInt32(buffer, 16, endian);
  const commandBytes = readUInt32(buffer, 20, endian);
  const commandEnd = 32 + commandBytes;
  if (commandCount === 0 || commandCount > 4096 || commandBytes < commandCount * 8 || commandEnd > buffer.length) return false;

  let offset = 32;
  const executableRanges = [];
  let entryOffset = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandEnd) return false;
    const command = readUInt32(buffer, offset, endian);
    const commandSize = readUInt32(buffer, offset + 4, endian);
    if (commandSize < 8 || offset + commandSize > commandEnd) return false;
    if (command === 0x19) {
      if (commandSize < 72) return false;
      const fileOffset = readUInt64(buffer, offset + 40, endian);
      const fileSize = readUInt64(buffer, offset + 48, endian);
      if (fileOffset === null || fileSize === null || fileOffset + fileSize > buffer.length) return false;
      const initialProtection = readUInt32(buffer, offset + 60, endian);
      if (fileSize > 0 && (initialProtection & 4) !== 0) executableRanges.push([fileOffset, fileOffset + fileSize]);
    } else if (command === 0x80000028) {
      if (commandSize < 24) return false;
      entryOffset = readUInt64(buffer, offset + 8, endian);
      if (entryOffset === null) return false;
    } else if (command === 0x5) {
      if (commandSize < 16) return false;
      const stateWords = readUInt32(buffer, offset + 12, endian);
      if (stateWords === 0 || 16 + (stateWords * 4) > commandSize) return false;
    }
    offset += commandSize;
  }
  if (offset !== commandEnd || executableRanges.length === 0) return false;
  return entryOffset !== null && entryOffset >= commandEnd
    && executableRanges.some(([start, end]) => entryOffset >= start && entryOffset < end && hasCodePayload(buffer, entryOffset, end));
}

function matchesMachO(buffer, cpu) {
  if (matchesThinMachO(buffer, cpu)) return true;
  if (buffer.length < 8) return false;

  let endian;
  let is64;
  const magicBe = buffer.readUInt32BE(0);
  const magicLe = buffer.readUInt32LE(0);
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    endian = 'be';
    is64 = magicBe === 0xcafebabf;
  } else if (magicLe === 0xcafebabe || magicLe === 0xcafebabf) {
    endian = 'le';
    is64 = magicLe === 0xcafebabf;
  } else {
    return false;
  }

  const count = readUInt32(buffer, 4, endian);
  const size = is64 ? 32 : 20;
  const headerEnd = 8 + (count * size);
  if (count === 0 || count > 64 || buffer.length < headerEnd) return false;
  const slices = [];
  let requestedCpuFound = false;
  for (let offset = 8; offset < 8 + (count * size); offset += size) {
    const cpuType = readUInt32(buffer, offset, endian);
    const sliceCpu = cpuType === MACH_CPU.arm64 ? 'arm64' : cpuType === MACH_CPU.x64 ? 'x64' : null;
    if (!sliceCpu) return false;
    const sliceOffset = is64 ? readUInt64(buffer, offset + 8, endian) : readUInt32(buffer, offset + 8, endian);
    const sliceSize = is64 ? readUInt64(buffer, offset + 16, endian) : readUInt32(buffer, offset + 12, endian);
    if (sliceOffset === null || sliceSize === null || sliceSize < 32
      || sliceOffset < headerEnd || sliceOffset + sliceSize > buffer.length) return false;
    if (slices.some(([start, end]) => sliceOffset < end && sliceOffset + sliceSize > start)) return false;
    if (!matchesThinMachO(buffer.subarray(sliceOffset, sliceOffset + sliceSize), sliceCpu)) return false;
    slices.push([sliceOffset, sliceOffset + sliceSize]);
    if (sliceCpu === cpu) requestedCpuFound = true;
  }
  return requestedCpuFound;
}

function matchesElfX64(buffer) {
  const entryPoint = buffer.length >= 32 ? readUInt64(buffer, 24, 'le') : null;
  if (buffer.length < 64
    || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || buffer[4] !== 2
    || buffer[5] !== 1
    || buffer[6] !== 1
    || ![2, 3].includes(buffer.readUInt16LE(16))
    || buffer.readUInt16LE(18) !== 0x3e
    || buffer.readUInt32LE(20) !== 1
    || entryPoint === null
    || entryPoint === 0
    || buffer.readUInt16LE(52) !== 64) return false;

  const programOffset = readUInt64(buffer, 32, 'le');
  const programSize = buffer.readUInt16LE(54);
  const programCount = buffer.readUInt16LE(56);
  if (programOffset === null || programSize < 56 || programCount === 0 || programCount > 4096
    || programOffset + (programSize * programCount) > buffer.length) return false;

  let entryInExecutableSegment = false;
  const programEnd = programOffset + (programSize * programCount);
  for (let index = 0; index < programCount; index += 1) {
    const offset = programOffset + (index * programSize);
    if (buffer.readUInt32LE(offset) !== 1) continue;
    const flags = buffer.readUInt32LE(offset + 4);
    const fileOffset = readUInt64(buffer, offset + 8, 'le');
    const virtualAddress = readUInt64(buffer, offset + 16, 'le');
    const fileSize = readUInt64(buffer, offset + 32, 'le');
    const memorySize = readUInt64(buffer, offset + 40, 'le');
    if (fileOffset === null || virtualAddress === null || fileSize === null || memorySize === null
      || memorySize < fileSize || fileOffset + fileSize > buffer.length) return false;
    if ((flags & 1) !== 0 && fileSize > 0 && entryPoint >= virtualAddress && entryPoint < virtualAddress + fileSize) {
      const entryFileOffset = fileOffset + (entryPoint - virtualAddress);
      const entryOverlapsHeaders = entryFileOffset < 64 || (entryFileOffset >= programOffset && entryFileOffset < programEnd);
      if (!entryOverlapsHeaders && hasCodePayload(buffer, entryFileOffset, fileOffset + fileSize)) entryInExecutableSegment = true;
    }
  }
  return entryInExecutableSegment;
}

function matchesPeX64(buffer) {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') return false;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset > buffer.length - 24
    || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    || buffer.readUInt16LE(peOffset + 4) !== 0x8664) return false;

  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const optionalOffset = peOffset + 24;
  const sectionOffset = optionalOffset + optionalSize;
  if (sectionCount === 0 || sectionCount > 96 || optionalSize < 112
    || sectionOffset + (sectionCount * 40) > buffer.length
    || (characteristics & 0x0002) === 0
    || (characteristics & 0x2000) !== 0
    || buffer.readUInt16LE(optionalOffset) !== 0x20b
    || buffer.readUInt32LE(optionalOffset + 16) === 0) return false;

  const headerSize = buffer.readUInt32LE(optionalOffset + 60);
  if (headerSize < sectionOffset + (sectionCount * 40) || headerSize > buffer.length) return false;
  const entryPoint = buffer.readUInt32LE(optionalOffset + 16);
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + (index * 40);
    const virtualAddress = buffer.readUInt32LE(offset + 12);
    const rawSize = buffer.readUInt32LE(offset + 16);
    const rawOffset = buffer.readUInt32LE(offset + 20);
    const sectionFlags = buffer.readUInt32LE(offset + 36);
    if (rawSize > 0 && (rawOffset < headerSize || rawOffset + rawSize > buffer.length)) return false;
    const virtualEnd = virtualAddress + rawSize;
    if (rawSize > 0 && (sectionFlags & 0x20000000) !== 0 && entryPoint >= virtualAddress && entryPoint < virtualEnd) {
      const entryFileOffset = rawOffset + (entryPoint - virtualAddress);
      if (hasCodePayload(buffer, entryFileOffset, rawOffset + rawSize)) return true;
    }
  }
  return false;
}

function assertNativeBinary(file, osName, cpu, label) {
  const buffer = fs.readFileSync(file);
  const valid = osName === 'darwin'
    ? matchesMachO(buffer, cpu)
    : osName === 'linux' && cpu === 'x64'
      ? matchesElfX64(buffer)
      : osName === 'win32' && cpu === 'x64'
        ? matchesPeX64(buffer)
        : false;
  if (!valid) throw new Error(`native binary format/architecture mismatch: ${label || `${osName}-${cpu}`}`);
}

module.exports = { assertNativeBinary, matchesMachO, matchesElfX64, matchesPeX64 };
