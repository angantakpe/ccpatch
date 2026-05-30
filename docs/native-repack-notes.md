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
