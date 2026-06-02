/**
 * bin/macho-sea-graph.mjs — parse and grow a Bun standalone-module-graph in a
 * Mach-O (darwin) Bun `--compile` binary, so a SIZE-INCREASING patched JS region
 * can be repacked instead of failing loud. This is the darwin-arm64 / darwin-x64
 * sibling of bin/bun-sea-graph.mjs (which handles ELF / linux-x64).
 *
 * Why this exists: the in-place splicer in repack-bundle.mjs requires the patched
 * JS region to be the SAME byte length as the original, because Bun's trailer and
 * module graph store blob-relative offsets that a naive splice does not update.
 * When the patched region GROWS, those offsets must be bumped by the delta or the
 * binary launches as bare `bun`. This module decodes Bun's serialization schema
 * (identical to the ELF case — the StandaloneModuleGraph is container-independent)
 * and rewrites every load-bearing offset, plus the Mach-O LC_SEGMENT_64 / section_64
 * file offsets, so the grown binary still dispatches the embedded entrypoint.
 *
 * ── Verified Bun SEA layout (Mach-O) ────────────────────────────────────────
 * Bun appends the StandaloneModuleGraph payload to the END of the executable file,
 * inside the file region mapped by the __LINKEDIT segment (the last LC_SEGMENT_64).
 * The payload itself has the SAME tail framing as the ELF case:
 *
 *   payload = [ blob (byte_count bytes) ][ Offsets (32) ][ trailer (16) ]
 *   blob    = [ …module contents… ][ module-record array ][ argv ]
 *
 * Unlike the ELF `.bun` SECTION (which is prefixed by an 8-byte payload_len u64),
 * the Mach-O payload is NOT preceded by a length header here — Bun locates it from
 * the file tail. We therefore find the trailer magic by scanning back from EOF and
 * derive the payload extent from Offsets.byte_count (validated against the trailer
 * position), rather than from a section header. Every StringPointer is relative to
 * the blob base = (trailer position − 16 − 32 − byte_count).
 *
 *   Offsets (extern struct, 32 bytes, little-endian) — identical to ELF:
 *     byte_count            : u64               @0   = blob length
 *     modules_ptr           : {off:u32,len:u32} @8   → module-record array
 *     entry_point_id        : u32               @16
 *     compile_exec_argv_ptr : {off:u32,len:u32} @20
 *     flags                 : u32               @28
 *
 *   CompiledModuleGraphFile record (52 bytes): six StringPointers at record
 *     offsets 0,8,16,24,32,40, then 4 enum bytes. Array len = modules_ptr.len/52.
 *
 * ── Growing the JS region by `delta` ───────────────────────────────────────
 * The blob/payload grows by `delta`; everything at a blob offset ≥ the splice
 * (content end) shifts by +delta. We add `delta` to:
 *   - Offsets.byte_count
 *   - Offsets.modules_ptr.off and compile_exec_argv_ptr.off (when ≥ splice)
 *   - every module-record StringPointer .off that is ≥ splice (len>0)
 *   - the grown module's contents.len (its content itself got longer)
 * and patch the Mach-O wrapper:
 *   - the LC_SEGMENT_64 segment that CONTAINS the splice grows filesize (+delta),
 *     and (if mapped, vmsize ≥ filesize) vmsize so the bytes stay mapped;
 *   - any LC_SEGMENT_64 whose fileoff is ≥ the splice shifts fileoff (+delta);
 *   - section_64 entries whose file offset is ≥ the splice shift (+delta);
 *   - LC_SYMTAB / LC_DYSYMTAB / LC_DYLD_INFO / LC_FUNCTION_STARTS /
 *     LC_DATA_IN_CODE / LC_CODE_SIGNATURE file offsets that are ≥ the splice shift.
 *
 * ── Code signature ──────────────────────────────────────────────────────────
 * A darwin binary carries an ad-hoc (or real) code signature in LC_CODE_SIGNATURE,
 * stored at the very end of __LINKEDIT. ANY growth invalidates it: the signed hash
 * pages no longer match. Re-signing is OUT OF SCOPE (it needs `codesign`, a darwin
 * host, and possibly an identity). Instead we STRIP the signature so the binary can
 * launch unsigned/ad-hoc-less: we remove the LC_CODE_SIGNATURE load command, shrink
 * __LINKEDIT to drop the signature blob, and leave the (now unmapped) tail bytes.
 * On Apple Silicon an unsigned binary still runs once the user re-ad-hoc-signs it
 * (`codesign -s - <bin>`); the caller (WS5/WS6 docs) must note the user re-sign step.
 * We DO NOT attempt to forge a valid CMS / ad-hoc signature.
 *
 * The module is Mach-O-64 little-endian only (Bun's darwin targets). Fat/universal
 * binaries must be thinned to the matching arch slice first (the caller handles the
 * fat magic and passes a single-arch slice or fails loud). PE/Windows growth is not
 * handled anywhere — the caller keeps failing loud for that. Every unexpected
 * topology throws rather than emitting a maybe-corrupt binary (native-repack's rule).
 */

const TRAILER = '\n---- Bun! ----\n';        // 16 bytes
const TRAILER_LEN = 16;
const OFFSETS_SIZE = 32;
const RECORD_SIZE = 52;                       // sizeof(CompiledModuleGraphFile)
const SP_OFFSETS_IN_RECORD = [0, 8, 16, 24, 32, 40]; // six StringPointers

// Mach-O magic (64-bit). On disk for arm64/x64 Bun builds the magic is MH_MAGIC_64.
const MH_MAGIC_64 = 0xfeedfacf;               // 64-bit, native (LE) byte order
const MH_CIGAM_64 = 0xcffaedfe;               // 64-bit, byte-swapped (BE)
const LC_SEGMENT_64          = 0x19;
const LC_SYMTAB              = 0x02;
const LC_DYSYMTAB            = 0x0b;
const LC_CODE_SIGNATURE      = 0x1d;
const LC_FUNCTION_STARTS     = 0x26;
const LC_DATA_IN_CODE        = 0x29;
const LC_DYLD_INFO           = 0x22;
const LC_DYLD_INFO_ONLY      = 0x80000022;
const LC_DYLD_EXPORTS_TRIE   = 0x80000033;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
const LC_SEGMENT_SPLIT_INFO  = 0x1e;

function u64(buf, pos) { return Number(buf.readBigUInt64LE(pos)); }
function u32(buf, pos) { return buf.readUInt32LE(pos); }

/**
 * lastIndexOf for a string needle searching backward from `before` (exclusive end).
 * Kept as an explicit helper so the trailer scan is byte-exact and unit-testable.
 */
export function lastIndexOf(buf, needle, before = buf.length) {
  const nb = Buffer.from(needle, 'latin1');
  const start = Math.min(before, buf.length) - 1;
  if (start < 0) return -1;
  return buf.lastIndexOf(nb, start);
}

/**
 * Parse the Mach-O header + load commands and the embedded Bun module graph.
 * Throws (never guesses) when the binary is not the expected Mach-O-64-LE Bun SEA.
 *
 * @param {Buffer} binary
 * @returns parsed graph descriptor (see fields below)
 */
export function parseMachoBunGraph(binary) {
  if (binary.length < 32) throw new Error('file too small to be a Mach-O binary');
  const magic = binary.readUInt32LE(0);
  if (magic === MH_CIGAM_64) {
    throw new Error('Mach-O is big-endian (byte-swapped); only little-endian arm64/x64 Bun SEA is supported for grow-repack');
  }
  if (magic !== MH_MAGIC_64) {
    // Fat binaries (0xcafebabe) must be thinned by the caller first.
    throw new Error('not a 64-bit little-endian Mach-O binary (thin the fat/universal slice first)');
  }

  // mach_header_64: magic(4) cputype(4) cpusubtype(4) filetype(4) ncmds(4)
  //                 sizeofcmds(4) flags(4) reserved(4) = 32 bytes
  const cputype = u32(binary, 4);
  const ncmds = u32(binary, 16);
  const sizeofcmds = u32(binary, 20);
  const HEADER_SIZE = 32;
  if (HEADER_SIZE + sizeofcmds > binary.length) {
    throw new Error('Mach-O load-command region extends past EOF — corrupt or truncated');
  }

  // Walk load commands.
  const loadCommands = [];
  const segments = [];
  let codeSig = null;        // { lcPos, cmdsize, dataoff, datasize }
  let linkedit = null;       // segment record for __LINKEDIT
  // Offset-bearing LCs whose file offset must shift when ≥ splice.
  // Each: { lcPos, kind, fields:[{name, pos}] } where pos points at a u32 file offset.
  const linkeditDataLCs = [];

  let p = HEADER_SIZE;
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > binary.length) throw new Error(`load command ${i} header runs past EOF`);
    const cmd = u32(binary, p);
    const cmdsize = u32(binary, p + 4);
    if (cmdsize < 8 || p + cmdsize > HEADER_SIZE + sizeofcmds) {
      throw new Error(`load command ${i} has invalid cmdsize ${cmdsize}`);
    }

    if (cmd === LC_SEGMENT_64) {
      // segment_command_64:
      //   cmd(4) cmdsize(4) segname(16) vmaddr(8)@0x18 vmsize(8)@0x20
      //   fileoff(8)@0x28 filesize(8)@0x30 maxprot(4) initprot(4)
      //   nsects(4)@0x40 flags(4)@0x44, then nsects * section_64(80)
      const segname = binary.toString('latin1', p + 8, p + 8 + 16).replace(/\0+$/, '');
      const vmaddr   = u64(binary, p + 0x18);
      const vmsize   = u64(binary, p + 0x20);
      const fileoff  = u64(binary, p + 0x28);
      const filesize = u64(binary, p + 0x30);
      const nsects   = u32(binary, p + 0x40);
      const sections = [];
      let sp = p + 0x48; // first section_64 follows the 72-byte segment_command_64 header
      for (let s = 0; s < nsects; s++) {
        // section_64: sectname(16) segname(16) addr(8)@0x20 size(8)@0x28
        //             offset(4)@0x30 align(4) reloff(4) nreloc(4) flags(4) ...
        if (sp + 80 > binary.length) throw new Error('section_64 runs past EOF');
        const sectname = binary.toString('latin1', sp, sp + 16).replace(/\0+$/, '');
        const sAddr   = u64(binary, sp + 0x20);
        const sSize   = u64(binary, sp + 0x28);
        const sOffPos = sp + 0x30;
        const sOffset = u32(binary, sOffPos);
        sections.push({ sectname, addr: sAddr, size: sSize, offset: sOffset, offsetPos: sOffPos, sp });
        sp += 80;
      }
      const seg = {
        lcPos: p, segname, vmaddr, vmsize, fileoff, filesize, nsects, sections,
        fileoffPos: p + 0x28, filesizePos: p + 0x30, vmsizePos: p + 0x20,
      };
      segments.push(seg);
      if (segname === '__LINKEDIT') linkedit = seg;
    } else if (cmd === LC_CODE_SIGNATURE) {
      // linkedit_data_command: cmd(4) cmdsize(4) dataoff(4)@8 datasize(4)@12
      codeSig = {
        lcPos: p, cmdsize,
        dataoff: u32(binary, p + 8), dataoffPos: p + 8,
        datasize: u32(binary, p + 12), datasizePos: p + 12,
      };
    } else if (cmd === LC_SYMTAB) {
      // symtab_command: cmd cmdsize symoff(4)@8 nsyms(4)@12 stroff(4)@16 strsize(4)@20
      linkeditDataLCs.push({ lcPos: p, kind: 'LC_SYMTAB', fields: [
        { name: 'symoff', pos: p + 8 }, { name: 'stroff', pos: p + 16 },
      ]});
    } else if (cmd === LC_DYSYMTAB) {
      // dysymtab_command — file-offset fields: tocoff@32 modtaboff@40 extrefsymoff@48
      // indirectsymoff@56 extreloff@64 locreloff@72
      linkeditDataLCs.push({ lcPos: p, kind: 'LC_DYSYMTAB', fields: [
        { name: 'tocoff', pos: p + 32 }, { name: 'modtaboff', pos: p + 40 },
        { name: 'extrefsymoff', pos: p + 48 }, { name: 'indirectsymoff', pos: p + 56 },
        { name: 'extreloff', pos: p + 64 }, { name: 'locreloff', pos: p + 72 },
      ]});
    } else if (cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) {
      // dyld_info_command: rebase_off@8 bind_off@16 weak_bind_off@24
      // lazy_bind_off@32 export_off@40 (each followed by a size u32)
      linkeditDataLCs.push({ lcPos: p, kind: 'LC_DYLD_INFO', fields: [
        { name: 'rebase_off', pos: p + 8 }, { name: 'bind_off', pos: p + 16 },
        { name: 'weak_bind_off', pos: p + 24 }, { name: 'lazy_bind_off', pos: p + 32 },
        { name: 'export_off', pos: p + 40 },
      ]});
    } else if (
      cmd === LC_FUNCTION_STARTS || cmd === LC_DATA_IN_CODE ||
      cmd === LC_DYLD_EXPORTS_TRIE || cmd === LC_DYLD_CHAINED_FIXUPS ||
      cmd === LC_SEGMENT_SPLIT_INFO
    ) {
      // linkedit_data_command: dataoff(4)@8 datasize(4)@12
      linkeditDataLCs.push({ lcPos: p, kind: '0x' + cmd.toString(16), fields: [
        { name: 'dataoff', pos: p + 8 },
      ]});
    }

    loadCommands.push({ cmd, cmdsize, pos: p });
    p += cmdsize;
  }

  if (!linkedit) throw new Error('no __LINKEDIT segment found (not a standard Mach-O executable)');

  // Locate the Bun trailer. The payload is appended at the file tail; the trailer
  // magic is the LAST 16 bytes of the embedded payload. When a code signature is
  // present it sits AFTER the payload (at the very end of __LINKEDIT), so we scan
  // backward for the trailer rather than assuming EOF.
  const trailerPos = lastIndexOf(binary, TRAILER, binary.length);
  if (trailerPos < 0) {
    throw new Error('Bun trailer magic not found anywhere in the Mach-O file — not a Bun SEA, or stripped.');
  }
  const offsetsPos = trailerPos - OFFSETS_SIZE;
  if (offsetsPos < 0) throw new Error('Bun trailer too close to file start — corrupt.');

  const byteCount = u64(binary, offsetsPos + 0);
  const modulesOff = u32(binary, offsetsPos + 8);
  const modulesLen = u32(binary, offsetsPos + 12);
  const entryPointId = u32(binary, offsetsPos + 16);
  const argvOff = u32(binary, offsetsPos + 20);
  const argvLen = u32(binary, offsetsPos + 24);

  const blobBase = offsetsPos - byteCount;            // file offset of blob byte 0
  if (blobBase < 0) {
    throw new Error(`Offsets.byte_count (${byteCount}) puts blob base before file start — schema mismatch.`);
  }
  if (modulesLen % RECORD_SIZE !== 0) {
    throw new Error(`modules_ptr.len (${modulesLen}) is not a multiple of record size ${RECORD_SIZE}; schema mismatch.`);
  }
  if (modulesOff + modulesLen > byteCount) {
    throw new Error(`modules_ptr (off ${modulesOff} len ${modulesLen}) extends past blob byte_count (${byteCount}); schema mismatch.`);
  }

  // Decode the module-record array. Each record's StringPointers are blob-relative.
  const recordCount = modulesLen / RECORD_SIZE;
  const records = [];
  for (let i = 0; i < recordCount; i++) {
    const recPos = blobBase + modulesOff + i * RECORD_SIZE;        // file offset of record
    const ptrs = SP_OFFSETS_IN_RECORD.map((rel) => ({
      fieldPos: recPos + rel,                                      // file offset of the {off,len} pair
      off: u32(binary, recPos + rel),
      len: u32(binary, recPos + rel + 4),
    }));
    const name = binary.toString('latin1', blobBase + ptrs[0].off, blobBase + ptrs[0].off + ptrs[0].len);
    records.push({
      index: i, recPos, name,
      ptr: { name: ptrs[0], contents: ptrs[1], sourcemap: ptrs[2], bytecode: ptrs[3], module_info: ptrs[4], bytecode_origin_path: ptrs[5] },
      allPtrs: ptrs,
    });
  }

  // The payload (blob+Offsets+trailer) must be covered by __LINKEDIT's file range
  // (Bun appends it there). Validate so we grow the right segment.
  const payloadStart = blobBase;
  const payloadEnd = trailerPos + TRAILER_LEN;
  const leStart = linkedit.fileoff;
  const leEnd = linkedit.fileoff + linkedit.filesize;
  if (!(payloadStart >= leStart && payloadEnd <= leEnd)) {
    throw new Error(
      `Bun payload [${payloadStart}, ${payloadEnd}) is not fully inside __LINKEDIT ` +
      `[${leStart}, ${leEnd}) — unexpected Mach-O topology, refusing to grow.`,
    );
  }

  return {
    macho: { cputype, ncmds, sizeofcmds, headerSize: HEADER_SIZE },
    segments, linkedit, codeSig, linkeditDataLCs, loadCommands,
    blobBase, payloadStart, payloadEnd, trailerPos, offsetsPos,
    offsets: { pos: offsetsPos, byteCount, modulesOff, modulesLen, entryPointId, argvOff, argvLen },
    records,
  };
}

/**
 * Strip the LC_CODE_SIGNATURE from a Mach-O buffer:
 *   - shrink __LINKEDIT filesize/vmsize to drop the trailing signature blob,
 *   - remove the LC_CODE_SIGNATURE load command (compacting the LC region and
 *     decrementing ncmds / sizeofcmds),
 *   - leave the now-unused tail bytes in the file (harmless; not mapped).
 *
 * The signature blob is the LAST thing in __LINKEDIT, so removing it just trims the
 * segment's file/vm size. We do NOT truncate the file buffer (the caller may still
 * splice after this); the dropped bytes simply stop being referenced. Returns a
 * fresh buffer (the LC region shifts, so we rebuild it).
 *
 * @param {Buffer} buf
 * @param {ReturnType<typeof parseMachoBunGraph>} g  parse of `buf`
 * @returns {Buffer} new buffer with the signature stripped
 */
export function stripCodeSignature(buf, g) {
  if (!g.codeSig) return Buffer.from(buf); // nothing to strip

  const out = Buffer.from(buf);
  const le = g.linkedit;

  // 1. Shrink __LINKEDIT so it no longer covers the signature blob. The signature
  //    sits at [dataoff, dataoff+datasize) at the tail of __LINKEDIT.
  const leEnd = le.fileoff + le.filesize;
  const shrink = leEnd - g.codeSig.dataoff;   // bytes from sig start to __LINKEDIT end
  if (shrink > 0 && shrink <= le.filesize) {
    const newFilesize = le.filesize - shrink;
    out.writeBigUInt64LE(BigInt(newFilesize), le.filesizePos);
    // vmsize must remain ≥ filesize. Only shrink it if it stays ≥ the new filesize.
    if (le.vmsize >= shrink && le.vmsize - shrink >= newFilesize) {
      out.writeBigUInt64LE(BigInt(le.vmsize - shrink), le.vmsizePos);
    }
  }

  // 2. Remove the LC_CODE_SIGNATURE load command by compacting the LC region.
  const lcPos = g.codeSig.lcPos;
  const cmdsize = g.codeSig.cmdsize;
  const headerSize = g.macho.headerSize;
  const lcRegionEnd = headerSize + g.macho.sizeofcmds;
  // Move everything after this LC up by cmdsize, then zero the freed tail.
  out.copy(out, lcPos, lcPos + cmdsize, lcRegionEnd);
  out.fill(0, lcRegionEnd - cmdsize, lcRegionEnd);
  // Decrement ncmds and sizeofcmds in the header.
  out.writeUInt32LE(g.macho.ncmds - 1, 16);
  out.writeUInt32LE(g.macho.sizeofcmds - cmdsize, 20);

  return out;
}

/**
 * Produce a grown Mach-O binary Buffer: replace the bytes [region.start, region.end)
 * (the entry module's JS content, in FILE coordinates) with `patchedBuf` (LARGER),
 * rewriting every Bun-graph offset and Mach-O load-command file offset by the delta.
 * The (now-invalid) code signature is STRIPPED — re-signing is the caller's job.
 *
 * @param {Buffer} binary       original Mach-O Bun SEA binary (thin, 64-bit LE)
 * @param {{start:number,end:number}} region  file range of the JS content to replace
 * @param {Buffer} patchedBuf   the replacement (larger) content
 * @param {{log?:Function,warn?:Function}} [io]
 * @returns {{output:Buffer, signatureStripped:boolean}}
 */
export function growMachoSea(binary, region, patchedBuf, io = {}) {
  const log = io.log || (() => {});

  // Parse first; if there is a signature, strip it and RE-PARSE (positions shift).
  let g = parseMachoBunGraph(binary);
  let working = binary;
  let signatureStripped = false;
  if (g.codeSig) {
    log(`grow(macho): stripping invalidated LC_CODE_SIGNATURE (dataoff ${g.codeSig.dataoff}, datasize ${g.codeSig.datasize}). Re-sign the output (codesign -s - <bin>) on a darwin host.`);
    working = stripCodeSignature(binary, g);
    signatureStripped = true;
    g = parseMachoBunGraph(working);
    if (g.codeSig) throw new Error('internal: code signature still present after strip');
  }

  const delta = patchedBuf.length - (region.end - region.start);
  if (delta <= 0) throw new Error(`growMachoSea called with non-positive delta (${delta}); use the in-place splicer instead.`);

  // Identify the module being grown: the record whose content BLOCK ends exactly at
  // region.end and contains region.start. Same matching rule as the ELF path: region
  // .start may sit inside the content block (after the `// @bun` prefix Bun stores but
  // the extractor strips), so we match on the content END and require start within it.
  const grown = g.records.find((r) => {
    const cStart = g.blobBase + r.ptr.contents.off;
    const cEnd = cStart + r.ptr.contents.len;
    return r.ptr.contents.len > 0 && cEnd === region.end && cStart <= region.start && region.start <= region.end;
  });
  if (!grown) {
    throw new Error(
      `Could not match the JS region [${region.start}, ${region.end}) to any module record's ` +
      `contents block (no record's content ends at ${region.end}). The grow-repack must rewrite the ` +
      `exact module Bun records — refusing to guess. (entry module: ${g.records[g.offsets.entryPointId]?.name ?? '?'})`,
    );
  }
  log(`grow(macho): module "${grown.name}" content ${grown.ptr.contents.len} -> ${grown.ptr.contents.len + delta} bytes (delta +${delta})`);

  // splice point in blob coordinates = end of the grown module's content block.
  const spliceBlob = grown.ptr.contents.off + grown.ptr.contents.len;
  const SP = region.end;                 // splice point, FILE coordinates
  if (g.blobBase + spliceBlob !== SP) {
    throw new Error(`internal: splice blob end (${g.blobBase + spliceBlob}) != region.end (${SP}).`);
  }

  // Work on a copy at ORIGINAL positions, then splice. Every rewritten byte lives
  // outside [region.start, region.end) so the splice preserves all rewrites.
  const buf = Buffer.from(working);
  const addU64 = (pos, d) => buf.writeBigUInt64LE(BigInt(u64(buf, pos) + d), pos);
  const addU32 = (pos, d) => buf.writeUInt32LE(u32(buf, pos) + d, pos);

  // 1. Bun graph: Offsets.byte_count grew by delta.
  addU64(g.offsets.pos + 0, delta);                            // Offsets.byte_count

  // 2. Offsets pointers that target ≥ the splice point.
  if (g.offsets.modulesOff >= spliceBlob) addU32(g.offsets.pos + 8, delta);    // modules_ptr.off
  if (g.offsets.argvLen > 0 && g.offsets.argvOff >= spliceBlob) addU32(g.offsets.pos + 20, delta); // argv.off

  // 3. Every module-record StringPointer whose target is ≥ the splice point.
  for (const r of g.records) {
    for (const ptr of r.allPtrs) {
      if (ptr.len > 0 && ptr.off >= spliceBlob) addU32(ptr.fieldPos, delta);
    }
  }
  // 4. The grown module's content got longer: its contents.len += delta.
  addU32(grown.ptr.contents.fieldPos + 4, delta);

  // 5. Mach-O wrapper fixups (FILE coordinates; splice inserts delta at SP).
  //    a) Grow the segment that CONTAINS the splice (filesize, and vmsize so the
  //       grown bytes stay mapped). Shift segments whose fileoff is ≥ SP.
  let grewContainingSegment = false;
  for (const seg of g.segments) {
    const segFileEnd = seg.fileoff + seg.filesize;
    if (seg.fileoff >= SP) {
      addU64(seg.fileoffPos, delta);                           // fileoff shift
    } else if (seg.fileoff < SP && SP <= segFileEnd && seg.filesize > 0) {
      addU64(seg.filesizePos, delta);                          // filesize += delta
      // vmsize must stay ≥ filesize. Bump it too (mapped segments only — __PAGEZERO
      // has filesize 0 so never matches here).
      if (seg.vmsize >= seg.filesize) addU64(seg.vmsizePos, delta);
      grewContainingSegment = true;
    }
    // b) section_64 file offsets within EACH segment that are ≥ SP shift by delta.
    for (const sect of seg.sections) {
      // section offset 0 means "no file content" (e.g. __bss); never shift those.
      if (sect.offset !== 0 && sect.offset >= SP) addU32(sect.offsetPos, delta);
    }
  }
  if (!grewContainingSegment) {
    throw new Error(
      `No LC_SEGMENT_64 contains the splice point (file ${SP}); the grown payload bytes would not be ` +
      `mapped at runtime. Refusing to emit a binary that cannot load its module graph.`,
    );
  }

  // c) __LINKEDIT-resident tables (symtab/dysymtab/dyld info/function starts/…): any
  //    file offset that is ≥ SP shifts by delta. Bun's payload is appended at the END
  //    of __LINKEDIT in our validated layout, so these tables precede SP and normally
  //    do NOT shift — but we handle the general case (a table after the payload) safely.
  for (const lc of g.linkeditDataLCs) {
    for (const f of lc.fields) {
      const v = u32(buf, f.pos);
      if (v !== 0 && v >= SP) addU32(f.pos, delta);
    }
  }

  // 6. Splice: [before][patched][after]. Rewrites in `before`/`after` survive.
  const out = Buffer.concat([
    buf.subarray(0, region.start),
    patchedBuf,
    buf.subarray(region.end),
  ]);
  if (out.length !== working.length + delta) {
    throw new Error(`internal: grown length ${out.length} != expected ${working.length + delta}.`);
  }
  return { output: out, signatureStripped };
}
