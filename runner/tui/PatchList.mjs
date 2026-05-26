import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

function statusColor(status) {
  if (status === 'ok') return 'green';
  if (status === 'drift') return 'yellow';
  if (status === 'error') return 'red';
  if (status === 'disabled') return 'gray';
  return 'white';
}

function pad(s, w) {
  s = String(s ?? '');
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

export function PatchList({ rows, selectedIndex }) {
  const header = h(
    Box,
    null,
    h(Text, { bold: true, underline: true }, pad('name', 28)),
    h(Text, { bold: true, underline: true }, pad('category', 16)),
    h(Text, { bold: true, underline: true }, pad('on', 4)),
    h(Text, { bold: true, underline: true }, pad('acks', 18)),
    h(Text, { bold: true, underline: true }, pad('status', 10))
  );

  const items = rows.map((r, i) => {
    const isSel = i === selectedIndex;
    const marker = isSel ? '> ' : '  ';
    return h(
      Box,
      { key: r.name },
      h(
        Text,
        { inverse: isSel },
        marker,
        pad(r.name, 26),
        pad(r.category, 16),
        pad(r.enabled ? 'yes' : 'no', 4),
        pad((r.acks || []).join(',') || '-', 18),
        h(Text, { color: statusColor(r.status), inverse: isSel }, pad(r.status, 10))
      )
    );
  });

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'single', paddingX: 1, flexGrow: 1 },
    header,
    ...items,
    rows.length === 0
      ? h(Text, { dimColor: true }, '(no patches match current filter)')
      : null
  );
}
