# Native (Bun-compiled) binary repack — mechanism & oversize handling

Audit notes for review finding #7. Scope: `bin/repack-bundle.mjs`,
`bin/extract-from-binary.mjs`, and the supporting parser in
`tools/bun-decompiler/decompile.mjs`.

## The real mechanism

Claude versions that ship as a Bun `--compile` native binary embed the CLI's
minified JavaScript as a NUL-terminated text region inside the executable
(ELF / Mach-O). Repack does **not** use `node-lief` to rewrite sections or the
overlay. It does a direct, offset-based, in-place Buffer splice:

1. **Locate the JS region.** `findJsRegion()` returns `[start, end)` — the JS
   text only, excluding the trailing NUL. Preferred path is the Bun
   module-marker parser (`parseModules` from `tools/bun-decompiler/decompile.mjs`),
   which walks `/$bunfs/root/<path>\0…` headers and ends the last JS module at
   the first NUL after `contentStart`. Fallback is the legacy anchor heuristic
   (find a known CLI string, jump back to the CJS wrapper opener, end at the
   next NUL).

2. **Normalise** the patched JS (`normalisePatchedJs()`): reject ESM-transformed
   output, require the Bun CJS wrapper opener, strip the self-invocation suffix
   that the extractor appends, and reject embedded NUL bytes.

3. **Size-match the region, then splice.** The output is
   `Buffer.concat([before, patchedBuf, after])` where `before = binary[0:start]`
   and `after = binary[end:]` (starting at the original NUL). The whole point of
   keeping the region the same byte length is that everything after it —
   including **Bun's trailer struct, which stores absolute file offsets** — keeps
   its original file offset. `bin/repack-bundle.mjs:236-247` documents that
   shifting the trailer makes the SEA dispatch fail (the binary launches as bare
   `bun` instead of the embedded entrypoint), because this script does not
   rewrite those offsets.

Why not `node-lief`: see the header comment at `bin/repack-bundle.mjs:7-14` —
LIEF's `patchAddress()` works on virtual addresses not file offsets, and the
overlay setter would ask LIEF to reconstruct the ELF and risk corrupting Bun's
trailer. **Note: the code path uses no LIEF at all.**

## Oversize handling — VERDICT: handled, errors loudly. No silent failure or corruption.

The README's worry ("padding only works when patched <= original") is the right
instinct, but the code already covers all three cases explicitly at
`bin/repack-bundle.mjs:248-264`:

- **`patched < original`** → pad with ASCII spaces inserted just before the
  closing `})` of the CJS wrapper (insignificant whitespace), bringing the region
  to the exact original byte count (lines 248-256).
- **`patched === original`** → spliced as-is.
- **`patched > original`** → **`die()`** with a clear, actionable message
  (lines 257-264):

  ```js
  } else if (patchedBuf.length > originalRegionSize) {
    die(
      `Patched JS (${patchedBuf.length.toLocaleString()} bytes) exceeds original JS region ` +
      `(${originalRegionSize.toLocaleString()} bytes). Growth is not supported by this repacker ` +
      `because the Bun trailer contains absolute file offsets that would need to be rewritten. ` +
      `Reduce the patched content or implement trailer-offset patching.`
    );
  }
  ```

`die()` (line 31) prints to stderr and `process.exit(1)`. Critically, this guard
runs **before** the output buffer is built and before anything is written, so an
oversize patch produces **no output file** — it cannot truncate or corrupt a
binary. There is **no growth path**: oversize is a hard, documented failure that
tells the user to reduce content or implement trailer-offset patching.

The comparison is apples-to-apples: `patchedBuf.length` is the UTF-8 byte length
of the normalised JS, and `originalRegionSize = region.end - region.start` is the
JS bytes excluding the NUL — both measure the same thing.

### Practical consequence for the patch set

The reviewer is right that the patch set normally *adds* code
(`fetch_interceptor` etc.), so the patched region is frequently **larger** than
the original embedded region. With the current repacker that means the native
(Bun-compiled) repack path will **fail loudly** for those versions rather than
silently corrupt — which is the safe outcome, but it does mean native repack is
only viable when the net patched size stays within the original region. This is a
real limitation to document, not a bug.

## Guard added

`bin/repack-bundle.mjs:266-281` — a defence-in-depth invariant added immediately
before the write: `if (output.length !== binary.length) die(...)`. The existing
oversize check (lines 257-264) and the padding branch already guarantee equality
when we reach the write, so this never fires in normal operation; it exists to
catch any *future* regression or a mis-located region that would change the final
length and thereby invalidate the Bun trailer offsets — failing before writing a
silently-broken binary. The previous `delta`-logging block (which could only log
a non-zero delta that can no longer occur) was replaced by this assertion.

The loud oversize failure itself was **already present** — I did not add it; I
verified it and strengthened the surrounding safety with the length invariant.

## Recommended README wording change (lead to apply — do NOT edit README here)

Current line (README.md:23):

> - **Native binary repack.** For versions shipped as a Bun-compiled binary, ccpatch extracts the embedded JS, patches it, and repacks via `node-lief`. The patched JS is padded to the original region size so the binary stays byte-for-byte the same length — no offset fixups needed.

Two inaccuracies: (a) it says repack happens "via `node-lief`" — the actual path
uses direct offset-based Buffer splicing and no LIEF; (b) "padded to the original
region size" implies patched is always ≤ original, but the patch set usually
*grows* the region, in which case repack deliberately fails. Recommended
replacement:

> - **Native binary repack.** For versions shipped as a Bun-compiled binary, ccpatch extracts the embedded JS, patches it, and splices the patched JS back into the binary at the original byte offset (direct Buffer rewrite — no `node-lief`, no offset fixups). The embedded JS region must stay the **same byte length** as the original, because Bun's trailer stores absolute file offsets this repacker does not rewrite. When the patched JS is *smaller*, it is padded with insignificant whitespace to the exact original size. When it is *larger* — which can happen because patches add code — repack **fails loudly** rather than corrupt the binary; that version then has to be built from the plain-JS path (or with a reduced patch set) until trailer-offset rewriting is implemented.

---

## Trailer-offset rewriting investigation (size-increasing repack) — BLOCKED, do NOT guess

This section records a focused attempt to implement the size-increasing repack path
(item 6: "rewrite stored absolute offsets by `newLen - oldLen` so a larger patched JS
region can be repacked"). The attempt was **driven empirically against a real linux-x64
fixture used as an executable oracle** (`storage/archives/claude-code-v2.1.158/bin/claude.exe`,
which boots and prints `2.1.158 (Claude Code)`), not by guessing. The conclusion is that
the trailer format is **not** the "simple set of absolute file offsets" the existing
code comments assumed, and a safe rewrite cannot be shipped without a verified decoder
for Bun's internal serialized module-graph schema. **The fail-loud oversize guard is kept
intact.** What follows is the verified ground truth and a precise plan for whoever picks
this up — so the next attempt starts from facts, not from re-discovering them.

### Verified facts about the v2.1.158 fixture (Bun 1.3.14, ELF x86-64)

All of the following were confirmed by direct binary inspection and by spawning the
modified binary and reading its `--version` output:

1. **The CLI is a Bun standalone module graph stored in an ELF section named `.bun`.**
   For the fixture: section file offset `102424576`, size `138194894`, so it ends at
   `240619470`. The file is *larger* than the section end — `.comment`, `.note.stapsdt`,
   `.symtab`, `.strtab`, `.shstrtab`, and the section-header table all follow the section.

2. **Bun finds its trailer by scanning backward from EOF for the magic
   `"\n---- Bun! ----\n"` (16 bytes), not by reading the ELF section table.** Proven two
   ways: (a) truncating the file at the `.bun` section end (dropping symtab/strtab/SHT
   entirely) still boots as Claude `2.1.158`; (b) appending up to 64 KiB of junk after the
   magic (pushing it that far from EOF) still boots. So the trailing ELF sections are
   *not* load-bearing for SEA dispatch, and the magic's distance-from-EOF is tolerated
   within a large window.

3. **Immediately before the magic is a 20-byte `Offsets` struct** (little-endian),
   matching Bun's `StandaloneModuleGraph.Offsets`:
   - `byte_count: u64` = `260` — the size of the serialized module-metadata block that
     precedes the struct (`offsetsStart - 260` lands exactly on the metadata block start).
   - `modules_ptr: { off: u32, len: u32 }` = `{138194837, 0}` — a **section-relative**
     pointer (SEC_OFF + off = 240619413, inside the trailer region).
   - `entry_point_id: u32` = `15`.

4. **Module *content* offsets are NOT stored as scalars anywhere in the file.** Searching
   the entire binary for a u32/u64 equal to cli.js's content offset (absolute or
   section-relative) returns **zero** hits. At runtime Bun locates each module's body by
   scanning the `/$bunfs/root/<path>\0// @bun …\n<content>` markers (the same mechanism
   `tools/bun-decompiler/decompile.mjs` uses) — not by a stored content pointer.

5. **The 260-byte metadata block is a packed serialized schema with mixed field widths
   (u32 offsets, u32 lengths, and u8 flag/loader/encoding bytes), and it is NOT a clean
   4-byte-aligned array of `StringPointer`s.** Decoding the cli.js record from its name
   pointer (`name.off = 120718632`, `name.len = 35`, which correctly resolves to
   `/$bunfs/root/src/entrypoints/cli.js`) shows the very next fields are flag bytes
   (`01 01 02 00`) before the next pointer — so a fixed 8-byte stride does not hold, and
   the real `StringPointer`s for the *other* modules land at non-4-byte-aligned file
   positions (e.g. `meta+39`, `meta+91`, `meta+143`, `meta+195`). A byte-by-byte scan for
   "u32 holding a section-relative offset ≥ the splice point" cannot distinguish a real
   pointer from a coincidental u32 inside minified JS or inside a length field — and
   misclassifying even one field silently corrupts the binary.

### What was tried and the exact failure mode

Using the fixture as an oracle, a size-increasing splice (inject a `/* … */` sentinel of
~4 KiB right after the CJS wrapper open of cli.js, `delta ≈ +4105`) was repacked under
several offset-rewriting strategies, each spawned and checked:

| Strategy | Result |
|---|---|
| Grow JS; fix ELF only (`.bun` size, post-`.bun` `sh_offset`s, `e_shoff`); no metadata rewrite | boots, prints **`1.3.14`** (bare Bun banner) — SEA dispatch broken |
| Above + rewrite the 4 metadata offsets that verifiably point at `/$bunfs/root/` markers ≥ splice | boots, prints **`1.3.14`** |
| Above + rewrite **all 14** u32 values (any byte alignment) in the metadata that hold a section-relative offset ≥ splice | boots, prints **`1.3.14`** |
| Above + rewrite `Offsets.byte_count` by `delta` | boots, prints **`1.3.14`** |
| Same experiments on the *truncated* binary (magic at EOF, no SHT — removes all ELF-table variables) | boots, prints **`1.3.14`** |
| **Control:** identity re-splice (same bytes, same length) | boots, prints **`2.1.158 (Claude Code)`** ✓ |

The control proves the harness, region location, and ELF-table fixups are otherwise
correct: a length-preserving splice still boots. **Every** size-increasing variant fell
back to bare Bun (`1.3.14` is the embedded Bun runtime version), which is the exact
"silent" dispatch-broken failure the existing comments warn about — except it is caught
here by the post-repack smoke check (`runSmokeCheck` flags the bare-`bun` banner). This
means there is at least one offset/length governing dispatch that is **not identifiable**
by the inspection methods above. Shipping any of these strategies would produce binaries
that look plausible but boot as bare Bun — exactly the corruption the task forbids.

### Precise plan to unblock (requires a *verified* Bun schema decoder)

Do not attempt offset rewriting again until the Bun `StandaloneModuleGraph` serialization
schema is decoded **field-by-field with certainty** for the target Bun version. Concretely:

1. **Pin the schema from Bun source, not from inspection.** Read
   `src/StandaloneModuleGraph.zig` (functions `toBytes` / `fromBytes` and the
   `CompiledModuleGraphFile` / `Offsets` / serialized-string-table layout) at the exact
   Bun tag that built the fixture — detect it from the embedded banner (the fixture is
   Bun **1.3.14**; `bin/repack-bundle.mjs:detectBunVersion` finds it). The version-pin is
   mandatory: the layout is unversioned in the binary and has changed across Bun releases.
2. **Build a decoder that enumerates every field as (kind, fileOffset, width):** module
   records (each with name/contents/sourcemap/bytecode `StringPointer`s + loader/encoding/
   flag bytes), the shared string-table base, `Offsets`, and `entry_point_id`. Validate it
   by round-tripping: decode → re-encode → assert byte-identical to the original `.bun`
   metadata. Only a clean round-trip proves the schema is fully understood.
3. **Determine the base each offset is relative to.** Confirmed so far: `Offsets.modules_ptr`
   and the metadata `StringPointer`s are **section-relative** (`SEC_OFF + off`). Verify the
   string-table entries use the same base, and check whether any field is relative to the
   *blob start* (which Bun may compute as `magicPos - byte_count - sizeof(Offsets)`), since
   the blob start moves when the JS region grows.
4. **Rewrite via the decoder, not via a byte scan:** for every decoded offset field whose
   target is ≥ the splice point, add `delta`. Then grow the `.bun` `sh_size` by `delta`,
   shift `sh_offset` of every section after `.bun` (and `e_shoff`) by `delta`, and grow
   `byte_count` only if the schema says it measures a region that grew. Leave program
   headers alone (verified: no `PT_LOAD` segment has `p_offset ≥ .bun` start in the fixture).
5. **Gate on the oracle.** Keep `runSmokeCheck` mandatory for the grow path and require a
   `/\d+\.\d+\.\d+ \(Claude Code\)/` match (stronger than the current bare-`bun`-only check)
   before any grow-path output may be written/shipped. A bare-Bun banner must remain a hard
   `die()`.
6. **Keep the fail-loud guard as the default** until step 2's round-trip passes on every
   fixture version (`v2.1.148/150/156/157/158`). Until then, `patched > original` must
   continue to `die()` — never emit a maybe-corrupt binary.

The skipped test `tests/repack.test.mjs › grow path (BLOCKED): …` documents the exact
oracle assertion the unblocking work must make pass.
