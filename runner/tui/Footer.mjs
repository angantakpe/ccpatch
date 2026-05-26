import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

export function Footer({ filter, count, total }) {
  return h(
    Box,
    { borderStyle: 'single', paddingX: 1, flexDirection: 'column' },
    h(
      Text,
      null,
      h(Text, { bold: true }, '↑/↓'),
      ' select  ',
      h(Text, { bold: true }, 'Enter'),
      ' expand  ',
      h(Text, { bold: true }, 'f'),
      ' filter  ',
      h(Text, { bold: true }, 'r'),
      ' reload  ',
      h(Text, { bold: true }, 'q'),
      ' quit'
    ),
    h(
      Text,
      { dimColor: true },
      `filter: ${filter}   showing ${count}/${total} patches`
    )
  );
}
