import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  locateWrapperCloseEnd,
  assertRegionEndIsNul,
  detectBunVersion,
} from '../bin/repack-bundle.mjs';

// Mirror the repacker's padding step: insert N spaces at the located close index.
function pad(text, padBytes) {
  const closeEnd = locateWrapperCloseEnd(text);
  return text.slice(0, closeEnd) + ' '.repeat(padBytes) + text.slice(closeEnd);
}

describe('repack padding placement — locateWrapperCloseEnd', () => {
  it('pads after the wrapper close, leaving a string literal that contains `})` byte-identical', () => {
    // Minified body holds a string literal whose value contains `})`. Padding must land
    // strictly after the wrapper close so the literal is never touched.
    const wrapper =
      '(function(exports, require, module, __filename, __dirname) {' +
      'var s = "trailing literal })";' +
      'module.exports = s;' +
      '})';

    // The locator returns the position immediately after the real wrapper close (file end here).
    const realCloseEnd = locateWrapperCloseEnd(wrapper);
    assert.equal(realCloseEnd, wrapper.length, 'close end is at the file end for this input');

    const padded = pad(wrapper, 10);

    // Padded output still parses as a function expression.
    assert.doesNotThrow(() => new Function(`return (${padded})`));

    // The string literal is unchanged — no spaces leaked inside it.
    assert.ok(padded.includes('"trailing literal })"'), 'literal must be byte-identical');

    // Spaces immediately follow the wrapper close `})`, not any earlier literal `})`.
    assert.equal(padded.slice(realCloseEnd - 2), '})' + ' '.repeat(10));

    // Byte length grew by exactly the pad count.
    assert.equal(padded.length, wrapper.length + 10);
  });

  it('pads after the close even when a string-literal `})` is the textually-last contiguous `})`', () => {
    // Here the wrapper-close `})` is followed by trailing whitespace AND the body's last token
    // is a literal containing `})`. The trim-based locator still resolves the true close (it
    // walks back over whitespace to the final `})`), and padding lands after it. This is the
    // exact case where blindly trusting "the last `})` is the close" is fragile: our locator
    // is defined by the same trimEnd().endsWith('})') rule normalisePatchedJs validates.
    const wrapper =
      '(function(exports, require, module, __filename, __dirname) {' +
      'module.exports = "ends in })";' +
      '})\n';

    const closeEnd = locateWrapperCloseEnd(wrapper);
    // closeEnd points just past the real `})` (before the trailing newline), not the literal.
    assert.equal(wrapper.slice(closeEnd - 2, closeEnd), '})');
    assert.ok(wrapper[closeEnd] === '\n', 'close is located before trailing whitespace');

    const padded = pad(wrapper, 6);
    assert.doesNotThrow(() => new Function(`return (${padded.trim()})`));
    assert.ok(padded.includes('"ends in })"'), 'literal must be byte-identical');
    assert.equal(padded.slice(closeEnd - 2, closeEnd + 6), '})' + ' '.repeat(6));
  });

  it('throws when no wrapper close `})` can be located', () => {
    assert.throws(() => locateWrapperCloseEnd('not a wrapper at all'), /wrapper close/);
    assert.throws(() => locateWrapperCloseEnd('(function(){return 1}'), /wrapper close/);
  });
});

describe('repack region.end NUL guard — assertRegionEndIsNul', () => {
  it('throws when the marker-parser region end is not a NUL byte', () => {
    // Craft a region whose end points at a non-NUL byte (simulating parseModules falling
    // back to nextBoundary instead of the trailer NUL).
    const binary = Buffer.from([0x41, 0x42, 0x43, 0x44]); // "ABCD", no NUL at end
    const region = { start: 0, end: 3, source: 'marker-parser' };
    assert.throws(() => assertRegionEndIsNul(binary, region), /not a NUL byte/);
  });

  it('passes when the marker-parser region end is a NUL byte', () => {
    const binary = Buffer.from([0x41, 0x42, 0x00, 0x44]); // NUL at index 2
    const region = { start: 0, end: 2, source: 'marker-parser' };
    assert.doesNotThrow(() => assertRegionEndIsNul(binary, region));
  });

  it('does not enforce the NUL for the legacy-anchor path (already NUL-guaranteed)', () => {
    const binary = Buffer.from([0x41, 0x42, 0x43, 0x44]); // no NUL
    const region = { start: 0, end: 3, source: 'legacy-anchor' };
    assert.doesNotThrow(() => assertRegionEndIsNul(binary, region));
  });
});

describe('repack Bun version detection — detectBunVersion', () => {
  it('detects a Bun/x.y.z banner', () => {
    const binary = Buffer.from('garbage\x00Bun/1.3.20 (linux)\x00more', 'latin1');
    assert.equal(detectBunVersion(binary), '1.3.20');
  });

  it('returns null when no version banner is present', () => {
    const binary = Buffer.from('no version here at all', 'latin1');
    assert.equal(detectBunVersion(binary), null);
  });
});
