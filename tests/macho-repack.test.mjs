import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMachoBunGraph,
  growMachoSea,
  stripCodeSignature,
  lastIndexOf,
} from '../bin/macho-sea-graph.mjs';
import { formatSkipLine } from '../bin/repack-bundle.mjs';

// ---------------------------------------------------------------------------
// Synthetic Mach-O Bun-SEA fixture builder.
//
// A real darwin arm64 binary won't run (or even parse meaningfully) on this linux
// host, and we can't ship a ~50 MB Mach-O fixture. Instead we hand-build a TINY but
// STRUCTURALLY FAITHFUL Mach-O-64-LE with exactly the topology growMachoSea models:
//   mach_header_64
//   LC_SEGMENT_64 __PAGEZERO  (fileoff 0, filesize 0)
//   LC_SEGMENT_64 __TEXT      (fileoff 0, maps the header + a code section)
//   LC_SEGMENT_64 __LINKEDIT  (maps the symtab + the appended Bun payload + signature)
//   LC_SYMTAB                 (file offset inside __LINKEDIT, BEFORE the payload)
//   LC_CODE_SIGNATURE         (file offset at the very tail of __LINKEDIT)
// The Bun payload (blob + Offsets(32) + trailer(16)) is appended inside __LINKEDIT,
// before the signature blob. This exercises every offset-rewrite branch:
//   - byte_count, modules_ptr.off, a StringPointer ≥ splice, the grown contents.len,
//   - the __LINKEDIT filesize/vmsize grow,
//   - a section_64 offset that is AFTER the splice (shifts),
//   - a section_64 offset BEFORE the splice (stays),
//   - LC_SYMTAB offsets before the splice (stay),
//   - signature strip.
// ---------------------------------------------------------------------------

const TRAILER = Buffer.from('\n---- Bun! ----\n', 'latin1');
const RECORD_SIZE = 52;
const OFFSETS_SIZE = 32;

const LC_SEGMENT_64    = 0x19;
const LC_SYMTAB        = 0x02;
const LC_CODE_SIGNATURE = 0x1d;

function buildBlob(modules) {
  // Lay out: [each module's name][each module's contents] then the module-record array.
  // Returns { blob, records:[{nameOff,nameLen,contentsOff,contentsLen}], modulesOff }.
  const chunks = [];
  let cursor = 0;
  const meta = [];
  for (const m of modules) {
    const nameBuf = Buffer.from(m.name, 'latin1');
    const contentsBuf = Buffer.from(m.contents, 'latin1');
    const nameOff = cursor; cursor += nameBuf.length; chunks.push(nameBuf);
    const contentsOff = cursor; cursor += contentsBuf.length; chunks.push(contentsBuf);
    meta.push({ nameOff, nameLen: nameBuf.length, contentsOff, contentsLen: contentsBuf.length });
  }
  const modulesOff = cursor;
  const recArray = Buffer.alloc(modules.length * RECORD_SIZE);
  modules.forEach((_m, i) => {
    const base = i * RECORD_SIZE;
    // StringPointer name @0, contents @8, rest (sourcemap/bytecode/module_info/origin) zeroed.
    recArray.writeUInt32LE(meta[i].nameOff, base + 0);
    recArray.writeUInt32LE(meta[i].nameLen, base + 4);
    recArray.writeUInt32LE(meta[i].contentsOff, base + 8);
    recArray.writeUInt32LE(meta[i].contentsLen, base + 12);
  });
  cursor += recArray.length;
  chunks.push(recArray);
  const blob = Buffer.concat(chunks);
  return { blob, meta, modulesOff, byteCount: blob.length };
}

function buildOffsets({ byteCount, modulesOff, modulesLen, entryPointId }) {
  const o = Buffer.alloc(OFFSETS_SIZE);
  o.writeBigUInt64LE(BigInt(byteCount), 0);   // byte_count
  o.writeUInt32LE(modulesOff, 8);             // modules_ptr.off
  o.writeUInt32LE(modulesLen, 12);            // modules_ptr.len
  o.writeUInt32LE(entryPointId, 16);          // entry_point_id
  o.writeUInt32LE(0, 20);                     // argv.off
  o.writeUInt32LE(0, 24);                     // argv.len
  o.writeUInt32LE(0, 28);                     // flags
  return o;
}

function seg64({ name, vmaddr, vmsize, fileoff, filesize, nsects = 0, sections = [] }) {
  const cmdsize = 72 + nsects * 80;
  const b = Buffer.alloc(cmdsize);
  b.writeUInt32LE(LC_SEGMENT_64, 0);
  b.writeUInt32LE(cmdsize, 4);
  b.write(name, 8, 16, 'latin1');
  b.writeBigUInt64LE(BigInt(vmaddr), 0x18);
  b.writeBigUInt64LE(BigInt(vmsize), 0x20);
  b.writeBigUInt64LE(BigInt(fileoff), 0x28);
  b.writeBigUInt64LE(BigInt(filesize), 0x30);
  b.writeUInt32LE(7, 0x38); // maxprot rwx
  b.writeUInt32LE(5, 0x3c); // initprot r-x
  b.writeUInt32LE(nsects, 0x40);
  b.writeUInt32LE(0, 0x44); // flags
  let sp = 0x48;
  for (const s of sections) {
    b.write(s.sectname, sp, 16, 'latin1');
    b.write(name, sp + 16, 16, 'latin1');
    b.writeBigUInt64LE(BigInt(s.addr || 0), sp + 0x20);
    b.writeBigUInt64LE(BigInt(s.size || 0), sp + 0x28);
    b.writeUInt32LE(s.offset >>> 0, sp + 0x30);
    sp += 80;
  }
  return b;
}

function symtabLC({ symoff, nsyms, stroff, strsize }) {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(LC_SYMTAB, 0);
  b.writeUInt32LE(24, 4);
  b.writeUInt32LE(symoff, 8);
  b.writeUInt32LE(nsyms, 12);
  b.writeUInt32LE(stroff, 16);
  b.writeUInt32LE(strsize, 20);
  return b;
}

function codeSigLC({ dataoff, datasize }) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(LC_CODE_SIGNATURE, 0);
  b.writeUInt32LE(16, 4);
  b.writeUInt32LE(dataoff, 8);
  b.writeUInt32LE(datasize, 12);
  return b;
}

/**
 * Build the whole synthetic file. Returns { binary, region, blobBase, expect } where
 * region is the FILE range of the entry module's contents (the grow target), and expect
 * captures pre-grow positions for assertions.
 *
 * @param {object} opts
 * @param {boolean} opts.withSignature  include an LC_CODE_SIGNATURE + trailing blob
 */
function buildFixture({ withSignature = true } = {}) {
  const modules = [
    { name: '/$bunfs/root/cli.js', contents: 'CLICONTENT_AAAA' }, // entry; the grow target
    { name: '/$bunfs/root/dep.js', contents: 'DEP' },
  ];
  const { blob, meta, modulesOff, byteCount } = buildBlob(modules);
  const modulesLen = modules.length * RECORD_SIZE;
  const offsets = buildOffsets({ byteCount, modulesOff, modulesLen, entryPointId: 0 });
  const payload = Buffer.concat([blob, offsets, TRAILER]); // blob + Offsets + trailer

  // Pre-payload __LINKEDIT content: a small symtab/strtab region BEFORE the payload.
  const symtab = Buffer.from('SYMTABSYMTABSTRTAB\0'); // 18 bytes, arbitrary
  const sigBlob = withSignature ? Buffer.from('FAKE_CODESIG_BLOB_DATA__________', 'latin1') : Buffer.alloc(0);

  // We will assemble: [header+LCs (we size after building LCs)][__TEXT body][__LINKEDIT body]
  // __LINKEDIT body = [symtab][payload][sigBlob]
  // First, build LCs with placeholder offsets, then fix offsets once positions are known.

  // Decide layout sizes.
  // We need the header+LC size first; build LCs to learn it. Build with zeroed offsets,
  // then patch. Use a __TEXT with one section (__text) that has a file offset BEFORE the
  // payload (stays) and place a SECOND fake section whose offset is AFTER the splice (shifts).
  const NUM_LCS = 3 /*segments*/ + 1 /*symtab*/ + (withSignature ? 1 : 0);

  // Build placeholder LCs to compute sizeofcmds.
  const pagezero = seg64({ name: '__PAGEZERO', vmaddr: 0, vmsize: 0x100000000, fileoff: 0, filesize: 0 });
  // __TEXT: two sections. __text offset before payload; __growmark offset after splice.
  const textSeg = seg64({
    name: '__TEXT', vmaddr: 0x100000000, vmsize: 0x1000, fileoff: 0, filesize: 0x1000, nsects: 2,
    sections: [
      { sectname: '__text', addr: 0x100000400, size: 0x10, offset: 0x400 },        // before payload
      { sectname: '__growmark', addr: 0x100000500, size: 0x10, offset: 0 /*patch later*/ },
    ],
  });
  const linkeditSeg = seg64({ name: '__LINKEDIT', vmaddr: 0x100001000, vmsize: 0x2000, fileoff: 0, filesize: 0 });
  const symLC = symtabLC({ symoff: 0, nsyms: 1, stroff: 0, strsize: 8 });
  const sigLC = withSignature ? codeSigLC({ dataoff: 0, datasize: sigBlob.length }) : Buffer.alloc(0);

  const HEADER_SIZE = 32;
  let lcs = [pagezero, textSeg, linkeditSeg, symLC];
  if (withSignature) lcs.push(sigLC);
  const sizeofcmds = lcs.reduce((n, b) => n + b.length, 0);
  const headerAndLcEnd = HEADER_SIZE + sizeofcmds;

  // __TEXT file region: [0, textFilesize). Put a small body so __LINKEDIT starts page-ish later.
  const textFilesize = Math.max(headerAndLcEnd + 64, 0x400 + 0x20); // ensure __text@0x400 fits
  const linkeditFileoff = textFilesize;
  const symtabOff = linkeditFileoff;                     // symtab right at __LINKEDIT start
  const payloadFileStart = symtabOff + symtab.length;    // payload after symtab
  const blobBase = payloadFileStart;                     // blob is first in payload
  const offsetsFileStart = blobBase + byteCount;
  const trailerFileStart = offsetsFileStart + OFFSETS_SIZE;
  const sigFileStart = trailerFileStart + TRAILER.length;
  const linkeditFilesize = (sigFileStart + sigBlob.length) - linkeditFileoff;

  // Entry module (cli.js) contents file range = the grow target.
  const entryContentsFileStart = blobBase + meta[0].contentsOff;
  const entryContentsFileEnd = entryContentsFileStart + meta[0].contentsLen;

  // The __growmark section's file offset sits AFTER the splice (region.end) — must shift.
  const growmarkOffset = trailerFileStart; // arbitrary, > splice

  // Now REBUILD the LCs with the real offsets.
  const textSegFinal = seg64({
    name: '__TEXT', vmaddr: 0x100000000, vmsize: 0x1000, fileoff: 0, filesize: textFilesize, nsects: 2,
    sections: [
      { sectname: '__text', addr: 0x100000400, size: 0x10, offset: 0x400 },
      { sectname: '__growmark', addr: 0x100000500, size: 0x10, offset: growmarkOffset },
    ],
  });
  const linkeditSegFinal = seg64({
    name: '__LINKEDIT', vmaddr: 0x100001000, vmsize: alignUp(linkeditFilesize, 0x1000),
    fileoff: linkeditFileoff, filesize: linkeditFilesize,
  });
  const symLCFinal = symtabLC({ symoff: symtabOff, nsyms: 1, stroff: symtabOff + 8, strsize: 8 });
  const sigLCFinal = withSignature ? codeSigLC({ dataoff: sigFileStart, datasize: sigBlob.length }) : Buffer.alloc(0);

  lcs = [pagezero, textSegFinal, linkeditSegFinal, symLCFinal];
  if (withSignature) lcs.push(sigLCFinal);

  // Header.
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(0xfeedfacf, 0);   // MH_MAGIC_64
  header.writeUInt32LE(0x0100000c, 4);   // cputype arm64
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(2, 12);           // MH_EXECUTE
  header.writeUInt32LE(NUM_LCS, 16);     // ncmds
  header.writeUInt32LE(sizeofcmds, 20);  // sizeofcmds
  header.writeUInt32LE(0x200085, 24);    // flags (PIE|TWOLEVEL|DYLDLINK-ish)

  // Assemble file: header + LCs + (__TEXT body padding up to linkeditFileoff) + __LINKEDIT body.
  const headerAndLcs = Buffer.concat([header, ...lcs]);
  const textPad = Buffer.alloc(linkeditFileoff - headerAndLcs.length);
  // place a marker at __text offset for realism
  if (0x400 + 0x10 <= textPad.length + headerAndLcs.length) {
    // nothing required; padding is fine
  }
  const linkeditBody = Buffer.concat([symtab, payload, sigBlob]);
  const binary = Buffer.concat([headerAndLcs, textPad, linkeditBody]);

  assert.equal(binary.length, linkeditFileoff + linkeditBody.length, 'file assembled to expected size');

  return {
    binary,
    region: { start: entryContentsFileStart, end: entryContentsFileEnd },
    blobBase,
    expect: {
      byteCount, modulesOff, modulesLen,
      linkeditFileoff, linkeditFilesize,
      growmarkOffset, symtabOff,
      sigFileStart, sigSize: sigBlob.length,
      trailerFileStart,
      entryContentsFileStart, entryContentsFileEnd,
      withSignature,
    },
  };
}

function alignUp(n, a) { return Math.ceil(n / a) * a; }

// ---------------------------------------------------------------------------

describe('macho parseMachoBunGraph — schema decode', () => {
  it('rejects non-Mach-O input', () => {
    assert.throws(() => parseMachoBunGraph(Buffer.from('\x7fELFnot a macho at all............')), /not a 64-bit/);
  });

  it('decodes the synthetic fixture: byte_count, entry = cli.js, payload inside __LINKEDIT', () => {
    const { binary, expect } = buildFixture({ withSignature: true });
    const g = parseMachoBunGraph(binary);
    assert.equal(g.offsets.byteCount, expect.byteCount, 'byte_count matches blob length');
    assert.equal(g.offsets.modulesLen, expect.modulesLen);
    assert.equal(g.records.length, 2);
    const entry = g.records[g.offsets.entryPointId];
    assert.ok(entry && /\/cli\.js$/.test(entry.name), `entry should be cli.js (got ${entry?.name})`);
    assert.ok(g.codeSig, 'code signature present');
    assert.equal(g.codeSig.dataoff, expect.sigFileStart);
    // Payload must be fully inside __LINKEDIT.
    assert.ok(g.payloadStart >= g.linkedit.fileoff);
    assert.ok(g.payloadEnd <= g.linkedit.fileoff + g.linkedit.filesize);
  });

  it('lastIndexOf finds the trailer at the expected position', () => {
    const { binary, expect } = buildFixture({ withSignature: true });
    const pos = lastIndexOf(binary, '\n---- Bun! ----\n');
    assert.equal(pos, expect.trailerFileStart);
  });
});

describe('macho stripCodeSignature', () => {
  it('removes the LC and shrinks __LINKEDIT; re-parse finds no signature', () => {
    const { binary } = buildFixture({ withSignature: true });
    const g = parseMachoBunGraph(binary);
    const stripped = stripCodeSignature(binary, g);
    assert.equal(stripped.length, binary.length, 'strip does not change file length (only LC + sizes)');
    const g2 = parseMachoBunGraph(stripped);
    assert.equal(g2.codeSig, null, 'no code signature after strip');
    assert.equal(g2.macho.ncmds, g.macho.ncmds - 1, 'ncmds decremented');
    assert.equal(g2.macho.sizeofcmds, g.macho.sizeofcmds - 16, 'sizeofcmds reduced by the LC size');
    // __LINKEDIT shrank by exactly the signature blob size (sig was the tail).
    assert.equal(
      g2.linkedit.filesize, g.linkedit.filesize - g.codeSig.datasize,
      '__LINKEDIT filesize shrank by the signature size',
    );
    // The Bun graph still decodes cleanly after the strip.
    const entry = g2.records[g2.offsets.entryPointId];
    assert.ok(/\/cli\.js$/.test(entry.name));
  });

  it('is a no-op (clone) when there is no signature', () => {
    const { binary } = buildFixture({ withSignature: false });
    const g = parseMachoBunGraph(binary);
    assert.equal(g.codeSig, null);
    const out = stripCodeSignature(binary, g);
    assert.ok(out.equals(binary));
  });
});

describe('macho growMachoSea — offset math', () => {
  it('rejects non-positive delta', () => {
    const { binary, region } = buildFixture({ withSignature: false });
    const same = Buffer.alloc(region.end - region.start, 0x41);
    assert.throws(() => growMachoSea(binary, region, same), /non-positive delta/);
  });

  it('refuses to guess when the region matches no module record', () => {
    const { binary } = buildFixture({ withSignature: false });
    assert.throws(
      () => growMachoSea(binary, { start: 5, end: 7 }, Buffer.alloc(999)),
      /Could not match the JS region/,
    );
  });

  it('grows the entry module and rewrites EVERY load-bearing offset (no signature)', () => {
    const { binary, region, expect } = buildFixture({ withSignature: false });
    const DELTA = 40;
    const origLen = region.end - region.start;
    const patched = Buffer.alloc(origLen + DELTA, 0x42); // larger content
    const { output, signatureStripped } = growMachoSea(binary, region, patched, {});
    assert.equal(signatureStripped, false);
    assert.equal(output.length, binary.length + DELTA, 'file grew by exactly delta');

    // Re-decode the grown output; every consistency check inside parseMachoBunGraph must hold.
    const g = parseMachoBunGraph(output);
    assert.equal(g.offsets.byteCount, expect.byteCount + DELTA, 'byte_count += delta');
    // modules_ptr.off was AFTER the grown content, so it shifted.
    assert.equal(g.offsets.modulesOff, expect.modulesOff + DELTA, 'modules_ptr.off += delta');
    // Entry (cli.js) contents.len grew by delta; its content offset is BEFORE the splice (unchanged).
    const entry = g.records[g.offsets.entryPointId];
    assert.equal(entry.ptr.contents.len, origLen + DELTA, 'entry contents.len += delta');
    // The entry name pointer (before the entry contents) is unchanged.
    assert.ok(/\/cli\.js$/.test(entry.name), 'entry name still resolves');
    // The dep module's name/contents pointers sit AFTER the entry contents → shifted, but
    // parseMachoBunGraph resolved the name correctly, proving the shift was consistent.
    const dep = g.records[1];
    assert.equal(dep.name, '/$bunfs/root/dep.js');
    assert.equal(dep.ptr.contents.len, 3, 'dep contents.len unchanged');

    // __LINKEDIT grew by delta (it contains the splice).
    assert.equal(g.linkedit.filesize, expect.linkeditFilesize + DELTA, '__LINKEDIT filesize += delta');
    assert.equal(g.linkedit.fileoff, expect.linkeditFileoff, '__LINKEDIT fileoff unchanged (it starts before splice)');

    // The __growmark section offset was AFTER the splice → shifted by delta.
    const text = g.segments.find(s => s.segname === '__TEXT');
    const growmark = text.sections.find(s => s.sectname === '__growmark');
    const textSect = text.sections.find(s => s.sectname === '__text');
    assert.equal(growmark.offset, expect.growmarkOffset + DELTA, '__growmark offset += delta (after splice)');
    assert.equal(textSect.offset, 0x400, '__text offset unchanged (before splice)');
  });

  it('strips the signature and still rewrites offsets (with signature)', () => {
    const { binary, region, expect } = buildFixture({ withSignature: true });
    const DELTA = 64;
    const origLen = region.end - region.start;
    const patched = Buffer.alloc(origLen + DELTA, 0x43);
    const { output, signatureStripped } = growMachoSea(binary, region, patched, {});
    assert.equal(signatureStripped, true, 'signature was stripped');

    const g = parseMachoBunGraph(output);
    assert.equal(g.codeSig, null, 'no signature in the grown output');
    assert.equal(g.offsets.byteCount, expect.byteCount + DELTA, 'byte_count += delta after strip+grow');
    const entry = g.records[g.offsets.entryPointId];
    assert.ok(/\/cli\.js$/.test(entry.name), 'entry resolves after strip+grow');
    assert.equal(entry.ptr.contents.len, origLen + DELTA, 'entry contents.len += delta');
    // The grown bytes must be present and mapped (filesize covers the new payload end).
    assert.ok(g.payloadEnd <= g.linkedit.fileoff + g.linkedit.filesize, 'payload still inside __LINKEDIT');
  });
});

describe('repack structured skip line — formatSkipLine', () => {
  it('produces the stable [repack:skip] prefix + single-line JSON shape', () => {
    const line = formatSkipLine({
      reason: 'native-grow-path-unavailable',
      platform: 'windows-or-unknown',
      droppedPatches: ['a', 'b'],
      detail: 'no grow path',
    });
    assert.ok(line.startsWith('[repack:skip] '), 'has the stable prefix');
    const json = JSON.parse(line.slice('[repack:skip] '.length));
    assert.equal(json.reason, 'native-grow-path-unavailable');
    assert.equal(json.platform, 'windows-or-unknown');
    assert.deepEqual(json.droppedPatches, ['a', 'b']);
    assert.equal(json.detail, 'no grow path');
    assert.ok(!line.includes('\n'), 'single line');
  });
});
