import fs from 'node:fs';
import path from 'node:path';
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { loadPatches } from '../loader.mjs';
import { readPatchFlags, readAcks } from '../config.mjs';
import { PROJECT_ROOT } from '../paths.mjs';
import { PatchList } from './PatchList.mjs';
import { Detail } from './Detail.mjs';
import { Footer } from './Footer.mjs';

const h = React.createElement;

const FILTERS = ['all', 'enabled', 'disabled', 'drifted', 'acked', 'unacked'];

const DRIFT_PATH = path.join(PROJECT_ROOT, 'storage', 'outputs', 'anchor-drift.jsonl');
const YAML_PATH = path.resolve(process.cwd(), 'ccpatch.yml');

function readLatestDrifts() {
  if (!fs.existsSync(DRIFT_PATH)) return {};
  const out = {};
  try {
    const raw = fs.readFileSync(DRIFT_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.patch) out[obj.patch] = obj;
      } catch {
        // skip bad line
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function buildRows() {
  let patches = {};
  let loadError = null;
  try {
    patches = await loadPatches({ includeModules: true });
  } catch (e) {
    loadError = e.message;
  }
  const flags = (() => {
    try { return readPatchFlags(YAML_PATH); } catch { return null; }
  })();
  const acks = (() => {
    try { return readAcks(YAML_PATH); } catch { return null; }
  })();
  const drifts = readLatestDrifts();

  const rows = Object.entries(patches).map(([name, mod]) => {
    const enabled = flags == null ? true : !!flags[name];
    const drift = drifts[name] || null;
    let status = 'ok';
    if (!enabled) status = 'disabled';
    else if (drift && (drift.verify_failed?.length || drift.candidates?.length)) status = 'drift';
    return {
      name,
      category: mod.category || '-',
      description: mod.description || '',
      capabilities: mod.capabilities || [],
      acks: (acks && acks[name]) || [],
      enabled,
      verify: mod.verify,
      source: mod.__source || (name.includes('/') ? 'module' : 'tree'),
      variant: mod.__resolvedVariant || 'default',
      latestDrift: drift,
      status,
      loadError: null,
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, loadError };
}

export function App() {
  const { exit } = useApp();
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterIdx, setFilterIdx] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const filter = FILTERS[filterIdx];

  const reload = useCallback(async () => {
    const { rows: r, loadError: err } = await buildRows();
    setRows(r);
    setLoadError(err);
  }, []);

  useEffect(() => {
    reload();
  }, [reload, reloadTick]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'all') return true;
      if (filter === 'enabled') return r.enabled;
      if (filter === 'disabled') return !r.enabled;
      if (filter === 'drifted') return r.status === 'drift';
      if (filter === 'acked') return (r.acks || []).length > 0;
      if (filter === 'unacked')
        return (r.capabilities || []).length > 0 && (r.acks || []).length === 0;
      return true;
    });
  }, [rows, filter]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
      return;
    }
    if (key.return) {
      setExpanded((e) => !e);
      return;
    }
    if (input === 'f') {
      setFilterIdx((i) => (i + 1) % FILTERS.length);
      return;
    }
    if (input === 'r') {
      setReloadTick((t) => t + 1);
      return;
    }
  });

  const selected = filtered[selectedIndex];

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { paddingX: 1 },
      h(Text, { bold: true }, 'ccpatch TUI'),
      h(Text, { dimColor: true }, '  —  ', YAML_PATH)
    ),
    loadError
      ? h(
          Box,
          { paddingX: 1 },
          h(Text, { color: 'red' }, 'load error: ', loadError)
        )
      : null,
    h(
      Box,
      { flexDirection: 'row' },
      h(Box, { width: '50%', flexDirection: 'column' }, h(PatchList, { rows: filtered, selectedIndex })),
      h(Box, { width: '50%', flexDirection: 'column' }, h(Detail, { row: selected }))
    ),
    expanded && selected
      ? h(
          Box,
          { borderStyle: 'single', paddingX: 1, flexDirection: 'column' },
          h(Text, { bold: true }, 'expanded:'),
          h(
            Text,
            null,
            JSON.stringify(
              {
                verify: selected.verify,
                capabilities: selected.capabilities,
                acks: selected.acks,
                drift: selected.latestDrift,
              },
              null,
              2
            )
          )
        )
      : null,
    h(Footer, { filter, count: filtered.length, total: rows.length })
  );
}
