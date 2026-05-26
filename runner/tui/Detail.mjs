import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

function formatVerify(v) {
  if (!v || typeof v !== 'object') return '(none)';
  const parts = [];
  for (const k of ['present', 'absent', 'count', 'weak']) {
    if (v[k] === undefined) continue;
    const val = Array.isArray(v[k]) ? v[k].join(', ') : JSON.stringify(v[k]);
    parts.push(`${k}: ${val}`);
  }
  return parts.join('\n') || '(empty)';
}

export function Detail({ row }) {
  if (!row) {
    return h(
      Box,
      { borderStyle: 'single', paddingX: 1, flexDirection: 'column' },
      h(Text, { dimColor: true }, '(no patch selected)')
    );
  }

  const caps = (row.capabilities || []).join(', ') || '(none)';
  const acks = (row.acks || []).join(', ') || '(none)';
  const verifyText = formatVerify(row.verify);
  const driftSummary = row.latestDrift
    ? `${row.latestDrift.ts}  candidates=${
        (row.latestDrift.candidates || []).length
      }  verify_failed=${(row.latestDrift.verify_failed || []).join('; ') || '-'}`
    : '(no recent drift entries)';

  return h(
    Box,
    {
      borderStyle: 'single',
      paddingX: 1,
      flexDirection: 'column',
      flexGrow: 1,
    },
    h(Text, { bold: true }, row.name),
    h(Text, { dimColor: true }, `category: ${row.category}   source: ${row.source}   variant: ${row.variant}`),
    h(Text, null, row.description || '(no description)'),
    h(Text, null, ''),
    h(Text, { bold: true }, 'capabilities:'),
    h(Text, null, '  ', caps),
    h(Text, { bold: true }, 'acked:'),
    h(Text, null, '  ', acks),
    h(Text, { bold: true }, 'verify:'),
    h(
      Box,
      { flexDirection: 'column', marginLeft: 2 },
      ...verifyText.split('\n').map((l, i) => h(Text, { key: i }, l))
    ),
    h(Text, { bold: true }, 'latest drift:'),
    h(Text, null, '  ', driftSummary),
    row.loadError
      ? h(Text, { color: 'red' }, 'load error: ', row.loadError)
      : null
  );
}
