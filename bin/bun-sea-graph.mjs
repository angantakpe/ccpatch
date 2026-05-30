/**
 * bin/bun-sea-graph.mjs — parse and grow a Bun standalone-module-graph in an
 * ELF (linux) Bun `--compile` binary, so a SIZE-INCREASING patched JS region can
 * be repacked instead of failing loud.
 *
 * Why this exists: the in-place splicer in repack-bundle.mjs requires the patched
 * JS region to be the SAME byte length as the original, because Bun's trailer and
 * module graph store blob-relative offsets that a naive splice does not update.
 * This module decodes Bun's actual serialization schema (verified against
 * src/standalone_graph/StandaloneModuleGraph.zig at tag bun-v1.3.14) and rewrites
 * every load-bearing offset by the growth delta, so the grown binary still
 * dispatches the embedded entrypoint instead of falling back to bare `bun`.
 *
 * ── Verified Bun SEA layout (ELF) ──────────────────────────────────────────
 * The embedded data lives in an ELF section named `.bun`:
 *
 *   .bun section = [ payload_len: u64 ][ payload (payload_len bytes) ]
 *   payload      = [ blob (byte_count bytes) ][ Offsets (32) ][ trailer (16) ]
 *   blob         = [ …module contents… ][ module-record array ][ argv ]
 *
 * `ELF.getData()` returns `section[8 .. 8+payload_len]` (the payload). Every
 * StringPointer offset is relative to the payload start (= section offset 8),
 * which we call the blob base. `fromBytes` reads:
 *   - Offsets at payload[payload_len-48 .. payload_len-16]
 *   - trailer at payload[payload_len-16 ..]  (must equal "\n---- Bun! ----\n")
 *   - the module graph working buffer as payload[0 .. byte_count]
 *
 *   Offsets (extern struct, 32 bytes, little-endian):
 *     byte_count            : u64            @0   = blob length
 *     modules_ptr           : {off:u32,len:u32} @8   → module-record array
 *     entry_point_id        : u32            @16
 *     compile_exec_argv_ptr : {off:u32,len:u32} @20
 *     flags                 : u32            @28
 *
 *   CompiledModuleGraphFile record (52 bytes): six StringPointers
 *     name,contents,sourcemap,bytecode,module_info,bytecode_origin_path
 *     at record offsets 0,8,16,24,32,40, then 4 enum bytes (encoding/loader/
 *     module_format/side). Array length = modules_ptr.len / 52.
 *
 * ── Growing the JS region by `delta` ───────────────────────────────────────
 * When the grown module's content gains `delta` bytes, everything at a blob
 * offset ≥ the content end shifts by +delta. We therefore add `delta` to:
 *   - the 8-byte `payload_len` header
 *   - Offsets.byte_count
 *   - Offsets.modules_ptr.off and compile_exec_argv_ptr.off (when ≥ splice)
 *   - every module record StringPointer .off that is ≥ splice (len>0)
 *   - the grown module's contents.len (its content itself got longer)
 * and patch the ELF wrapper: grow `.bun` sh_size, shift sh_offset of sections
 * after the splice, shift e_shoff, grow the containing PT_LOAD's p_filesz/p_memsz
 * (and shift any program header that starts after the splice).
 *
 * The module is ELF-64 little-endian only (the Bun linux-x64 target). Mach-O /
 * PE growth is intentionally NOT handled here — the caller keeps failing loud for
 * those. Every unexpected topology throws rather than emitting a maybe-corrupt
 * binary (native-repack's hard rule).
 */

const TRAILER = '\n---- Bun! ----\n';        // 16 bytes
const TRAILER_LEN = 16;
const OFFSETS_SIZE = 32;
const RECORD_SIZE = 52;                       // sizeof(CompiledModuleGraphFile)
const BLOB_HEADER = 8;                        // [u64 payload_len] prefix on the .bun section
const SP_OFFSETS_IN_RECORD = [0, 8, 16, 24, 32, 40]; // six StringPointers

function u64(buf, pos) { return Number(buf.readBigUInt64LE(pos)); }
function u32(buf, pos) { return buf.readUInt32LE(pos); }

/**
 * Parse the ELF section/program headers and the embedded Bun module graph.
 * Throws (never guesses) when the binary is not the expected ELF64-LE Bun SEA.
 *
 * @param {Buffer} binary
 * @returns parsed graph descriptor (see fields below)
 */
export function parseElfBunGraph(binary) {
  if (binary.length < 64 || binary.readUInt32LE(0) !== 0x464c457f) {
    throw new Error('not an ELF binary');
  }
  if (binary[4] !== 2 || binary[5] !== 1) {
    throw new Error('only ELF64 little-endian is supported for grow-repack');
  }
  const e_phoff = u64(binary, 0x20);
  const e_shoff = u64(binary, 0x28);
  const e_phentsize = binary.readUInt16LE(0x36);
  const e_phnum = binary.readUInt16LE(0x38);
  const e_shentsize = binary.readUInt16LE(0x3a);
  const e_shnum = binary.readUInt16LE(0x3c);
  const e_shstrndx = binary.readUInt16LE(0x3e);

  // Section-name string table.
  const shstrSh = e_shoff + e_shstrndx * e_shentsize;
  const shstrOff = u64(binary, shstrSh + 24);
  const readName = (off) => {
    let e = off;
    while (e < binary.length && binary[e] !== 0) e++;
    return binary.toString('latin1', off, e);
  };

  const sections = [];
  let bun = null;
  for (let i = 0; i < e_shnum; i++) {
    const sh = e_shoff + i * e_shentsize;
    const name = readName(shstrOff + u32(binary, sh));
    const offset = u64(binary, sh + 24);
    const size = u64(binary, sh + 32);
    const rec = { i, name, sh, offset, size };
    sections.push(rec);
    if (name === '.bun') bun = rec;
  }
  if (!bun) throw new Error('no .bun section found (not a Bun SEA ELF, or stripped)');

  // .bun = [u64 payload_len][payload]. payload = [blob][Offsets][trailer].
  const payloadLen = u64(binary, bun.offset);
  if (BLOB_HEADER + payloadLen !== bun.size) {
    throw new Error(
      `.bun header payload_len (${payloadLen}) + ${BLOB_HEADER} != section size (${bun.size}); ` +
      `unexpected blob-header layout — refusing to grow.`,
    );
  }
  const blobBase = bun.offset + BLOB_HEADER;            // file offset of blob byte 0
  const offsetsPos = blobBase + payloadLen - OFFSETS_SIZE - TRAILER_LEN;
  const trailerPos = blobBase + payloadLen - TRAILER_LEN;
  const trailer = binary.toString('latin1', trailerPos, trailerPos + TRAILER_LEN);
  if (trailer !== TRAILER) {
    throw new Error(`Bun trailer magic not found at expected position (got ${JSON.stringify(trailer)}).`);
  }

  const byteCount = u64(binary, offsetsPos + 0);
  const modulesOff = u32(binary, offsetsPos + 8);
  const modulesLen = u32(binary, offsetsPos + 12);
  const entryPointId = u32(binary, offsetsPos + 16);
  const argvOff = u32(binary, offsetsPos + 20);
  const argvLen = u32(binary, offsetsPos + 24);

  if (byteCount + OFFSETS_SIZE + TRAILER_LEN !== payloadLen) {
    throw new Error(
      `Offsets.byte_count (${byteCount}) + ${OFFSETS_SIZE} + ${TRAILER_LEN} != payload_len (${payloadLen}); ` +
      `schema mismatch — refusing to grow.`,
    );
  }
  if (modulesLen % RECORD_SIZE !== 0) {
    throw new Error(`modules_ptr.len (${modulesLen}) is not a multiple of record size ${RECORD_SIZE}; schema mismatch.`);
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

  // Program headers (we need the PT_LOAD that maps the .bun data).
  const programHeaders = [];
  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    programHeaders.push({
      ph,
      p_type: u32(binary, ph + 0),
      p_offset: u64(binary, ph + 8),
      p_filesz: u64(binary, ph + 32),
      p_memsz: u64(binary, ph + 40),
    });
  }

  return {
    elf: { e_phoff, e_shoff, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx },
    bun, sections, programHeaders,
    blobBase, payloadLen, payloadLenPos: bun.offset,
    offsets: {
      pos: offsetsPos, byteCount, modulesOff, modulesLen, entryPointId, argvOff, argvLen,
    },
    records,
  };
}

/**
 * Produce a grown binary Buffer: replace the bytes [region.start, region.end)
 * (the entry module's JS content, in FILE coordinates) with `patchedBuf` (which
 * is LARGER), rewriting every Bun-graph and ELF offset by the growth delta.
 *
 * @param {Buffer} binary       original ELF Bun SEA binary
 * @param {{start:number,end:number}} region  file range of the JS content to replace
 * @param {Buffer} patchedBuf   the replacement (larger) content
 * @param {{log?:Function,warn?:Function}} [io]
 * @returns {Buffer} the grown binary
 */
export function growBunSeaBinary(binary, region, patchedBuf, io = {}) {
  const log = io.log || (() => {});
  const g = parseElfBunGraph(binary);
  const delta = patchedBuf.length - (region.end - region.start);
  if (delta <= 0) throw new Error(`growBunSeaBinary called with non-positive delta (${delta}); use the in-place splicer instead.`);

  // Identify the module being grown: the record whose content BLOCK ends exactly
  // at region.end and contains region.start. region.start/end are FILE offsets;
  // the record's contents StringPointer is blob-relative (blobBase + off).
  //
  // region.start may sit INSIDE the content block, not at its start: Bun's stored
  // `contents` begins with a `// @bun …\n` directive that the marker parser (and
  // the extracted/patched JS) strips, so the spliced JS replaces only the bytes
  // after that prefix. The prefix lives in [contentStart, region.start) and is
  // preserved untouched. We match on the content END (region.end), which uniquely
  // identifies the block, and require region.start to be within it.
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
  log(`grow: module "${grown.name}" content ${grown.ptr.contents.len} -> ${grown.ptr.contents.len + delta} bytes (delta ${delta >= 0 ? '+' : ''}${delta})`);

  // splice point in blob coordinates = end of the grown module's content block.
  const spliceBlob = grown.ptr.contents.off + grown.ptr.contents.len;
  const SP = region.end;                 // splice point, FILE coordinates
  if (g.blobBase + spliceBlob !== SP) {
    throw new Error(`internal: splice blob end (${g.blobBase + spliceBlob}) != region.end (${SP}).`);
  }

  // Work on a copy at the ORIGINAL positions, then splice. Every rewritten byte
  // lives outside [region.start, region.end) (either before it or after it), so
  // the splice preserves all rewrites while inserting the grown content.
  const buf = Buffer.from(binary);

  const addU64 = (pos, d) => buf.writeBigUInt64LE(BigInt(u64(buf, pos) + d), pos);
  const addU32 = (pos, d) => buf.writeUInt32LE(u32(buf, pos) + d, pos);

  // 1. .bun blob header (payload_len) and Offsets.byte_count both measure the
  //    blob/payload which grew by delta.
  addU64(g.payloadLenPos, delta);
  addU64(g.offsets.pos + 0, delta);                            // Offsets.byte_count

  // 2. Offsets pointers that target ≥ the splice point.
  if (g.offsets.modulesOff >= spliceBlob) addU32(g.offsets.pos + 8, delta);   // modules_ptr.off
  if (g.offsets.argvLen > 0 && g.offsets.argvOff >= spliceBlob) addU32(g.offsets.pos + 20, delta); // argv.off

  // 3. Every module-record StringPointer whose target is ≥ the splice point.
  for (const r of g.records) {
    for (const p of r.allPtrs) {
      if (p.len > 0 && p.off >= spliceBlob) addU32(p.fieldPos, delta);
    }
  }
  // 4. The grown module's content got longer: its contents.len += delta.
  addU32(grown.ptr.contents.fieldPos + 4, delta);

  // 5. ELF wrapper fixups (FILE coordinates; splice inserts delta at SP).
  //    .bun section grows; sections after the splice shift; SHT shifts.
  addU64(g.bun.sh + 32, delta);                                // .bun sh_size += delta
  for (const s of g.sections) {
    if (s.offset >= SP) addU64(s.sh + 24, delta);              // sh_offset of sections after splice
  }
  if (g.elf.e_shoff >= SP) addU64(0x28, delta);                // e_shoff

  // Program headers: grow the segment that CONTAINS the splice; shift segments
  // that start at/after it. Fail loud on a topology we don't model.
  let grewContainingLoad = false;
  for (const p of g.programHeaders) {
    if (p.p_offset >= SP) {
      addU64(p.ph + 8, delta);                                 // p_offset
    } else if (p.p_offset < SP && SP < p.p_offset + p.p_filesz) {
      addU64(p.ph + 32, delta);                                // p_filesz
      addU64(p.ph + 40, delta);                                // p_memsz
      if (p.p_type === 1 /* PT_LOAD */) grewContainingLoad = true;
    }
  }
  if (!grewContainingLoad) {
    throw new Error(
      `No PT_LOAD segment contains the splice point (file ${SP}); the grown .bun bytes would not be ` +
      `mapped at runtime. Refusing to emit a binary that cannot load its module graph.`,
    );
  }

  // 6. Splice: [before][patched][after]. Rewrites in `before`/`after` survive.
  const out = Buffer.concat([
    buf.subarray(0, region.start),
    patchedBuf,
    buf.subarray(region.end),
  ]);
  if (out.length !== binary.length + delta) {
    throw new Error(`internal: grown length ${out.length} != expected ${binary.length + delta}.`);
  }
  return out;
}
