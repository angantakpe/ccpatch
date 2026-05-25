/**
 * Base64-VLQ decoder for source map v3 mappings.
 *
 * Each segment in the mappings string encodes 4 or 5 fields:
 *   [genColumn, sourceIndex, sourceLine, sourceColumn, nameIndex?]
 * Values are relative (deltas) to the previous segment's values.
 * Segments are comma-separated within a line; lines are semicolon-separated.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int32Array(128);
B64_LOOKUP.fill(-1);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

/**
 * Decode a single VLQ value starting at position `pos` in `str`.
 * Returns [decodedValue, nextPos].
 */
function decodeVLQValue(str, pos) {
  let result = 0;
  let shift = 0;
  let digit;
  do {
    const charCode = str.charCodeAt(pos++);
    digit = B64_LOOKUP[charCode];
    if (digit === -1) throw new Error(`Invalid base64 char at pos ${pos - 1}`);
    result += (digit & 0x1f) * (2 ** shift);
    shift += 5;
  } while (digit & 0x20);
  // Sign is in the least significant bit
  const half = Math.floor(result / 2);
  return [(result % 2) ? -half : half, pos];
}

/**
 * Decode the full mappings string into an array of segments grouped by generated line.
 *
 * Returns: Array of lines, each line is an array of segments.
 * Each segment is [genColumn, sourceIndex, sourceLine, sourceColumn] (4 fields)
 * or [genColumn, sourceIndex, sourceLine, sourceColumn, nameIndex] (5 fields).
 * All values are absolute (not deltas).
 */
export function decodeMappings(mappingsStr) {
  const lines = [];
  let currentLine = [];

  // Running state for delta decoding
  let genCol = 0;
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;

  let pos = 0;
  const len = mappingsStr.length;

  while (pos < len) {
    const ch = mappingsStr.charCodeAt(pos);

    if (ch === 59) { // ';' — new generated line
      lines.push(currentLine);
      currentLine = [];
      genCol = 0; // genColumn resets per line
      pos++;
      continue;
    }

    if (ch === 44) { // ',' — next segment on same line
      pos++;
      continue;
    }

    // Decode segment fields
    let val;
    const segment = [];

    // Field 0: genColumn (delta)
    [val, pos] = decodeVLQValue(mappingsStr, pos);
    genCol += val;
    segment.push(genCol);

    // Check if more fields follow (not at end, comma, or semicolon)
    if (pos < len && mappingsStr.charCodeAt(pos) !== 44 && mappingsStr.charCodeAt(pos) !== 59) {
      // Field 1: sourceIndex (delta)
      [val, pos] = decodeVLQValue(mappingsStr, pos);
      srcIdx += val;
      segment.push(srcIdx);

      // Field 2: sourceLine (delta)
      [val, pos] = decodeVLQValue(mappingsStr, pos);
      srcLine += val;
      segment.push(srcLine);

      // Field 3: sourceColumn (delta)
      [val, pos] = decodeVLQValue(mappingsStr, pos);
      srcCol += val;
      segment.push(srcCol);

      // Field 4: nameIndex (optional, delta)
      if (pos < len && mappingsStr.charCodeAt(pos) !== 44 && mappingsStr.charCodeAt(pos) !== 59) {
        [val, pos] = decodeVLQValue(mappingsStr, pos);
        nameIdx += val;
        segment.push(nameIdx);
      }
    }

    currentLine.push(segment);
  }

  // Push the last line
  lines.push(currentLine);

  return lines;
}
