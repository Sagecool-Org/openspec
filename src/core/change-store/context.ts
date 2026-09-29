import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadChangeContext,
  type ChangeContext,
  type LoadChangeContextOptions,
} from '../artifact-graph/instruction-loader.js';
import type { ChangeStore } from './types.js';

/**
 * Loads a change's context through its store. The file store keeps the
 * upstream path (the loader reads the change directory); any other store is
 * asked for a snapshot first, and the loader works from that instead of files.
 */
export async function loadChangeContextFor(
  store: ChangeStore,
  changeName: string,
  schemaName?: string,
  options: Omit<LoadChangeContextOptions, 'snapshot'> = {}
): Promise<ChangeContext> {
  if (store.kind === 'file') {
    return loadChangeContext(store.projectRoot, changeName, schemaName, options);
  }
  const snapshot = await store.snapshot(changeName);
  return loadChangeContext(store.projectRoot, changeName, schemaName, {
    ...options,
    changeDir: options.changeDir ?? path.join(store.changesDir, changeName),
    snapshot,
  });
}

/**
 * Runs a read-only, file-shaped command against a change from any store. The
 * file store hands over its own root. Another store exports the change into a
 * temporary root laid out as upstream expects (`openspec/changes/<name>/`,
 * with `openspec/specs` linked to the real main specs) and removes it after;
 * nothing is written back, so there is one truth and no sync.
 */
export async function withChangeOnDisk<T>(
  store: ChangeStore,
  changeName: string,
  run: (root: { path: string; changesDir: string; specsDir: string }) => Promise<T>
): Promise<T> {
  const specsDir = path.join(store.projectRoot, 'openspec', 'specs');
  if (store.kind === 'file') {
    return run({
      path: store.projectRoot,
      changesDir: store.changesDir,
      specsDir,
    });
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `openspec-${store.kind}-${changeName}-`));
  try {
    const changesDir = path.join(tempRoot, 'openspec', 'changes');
    await store.exportChange(changeName, path.join(changesDir, changeName));
    const linkedSpecs = path.join(tempRoot, 'openspec', 'specs');
    if (fs.existsSync(specsDir)) {
      fs.symlinkSync(specsDir, linkedSpecs, 'dir');
    } else {
      fs.mkdirSync(linkedSpecs, { recursive: true });
    }
    for (const config of ['config.yaml', 'config.yml']) {
      const source = path.join(store.projectRoot, 'openspec', config);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tempRoot, 'openspec', config));
    }
    const schemas = path.join(store.projectRoot, 'openspec', 'schemas');
    if (fs.existsSync(schemas)) fs.symlinkSync(schemas, path.join(tempRoot, 'openspec', 'schemas'), 'dir');
    return await run({ path: tempRoot, changesDir, specsDir });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
