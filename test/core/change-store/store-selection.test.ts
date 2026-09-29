import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOpenSpecRoot, toPlanningHome, toRootOutput } from '../../../src/core/root-selection.js';
import {
  BoardChangeStore,
  BoardConfigError,
  BoardUnreachableError,
  FileChangeStore,
  findBoardConfig,
} from '../../../src/core/change-store/index.js';

describe('change store selection by the resolved root', () => {
  let root: string;
  const savedEnv = {
    AGORA_URL: process.env.AGORA_URL,
    AGORA_REPO: process.env.AGORA_REPO,
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-store-selection-')));
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'demo'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, 'openspec', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
    fs.writeFileSync(path.join(root, 'openspec', 'changes', 'demo', '.openspec.yaml'), 'schema: spec-driven\n');
    delete process.env.AGORA_URL;
    delete process.env.AGORA_REPO;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('gives a root without .agora.json the file store and a repo planning home', async () => {
    const resolved = await resolveOpenSpecRoot({ startPath: root });
    expect(resolved.store).toBeInstanceOf(FileChangeStore);
    expect(resolved.store.kind).toBe('file');
    expect(resolved.store.changesDir).toBe(resolved.changesDir);
    expect(toPlanningHome(resolved)).toEqual({
      kind: 'repo',
      root,
      changesDir: path.join(root, 'openspec', 'changes'),
      defaultSchema: 'spec-driven',
    });
  });

  it('gives a root that declares a board the board store and a board planning home', async () => {
    fs.writeFileSync(
      path.join(root, '.agora.json'),
      JSON.stringify({ repo: 'sagecool', url: 'https://board.example.test/' })
    );
    const resolved = await resolveOpenSpecRoot({ startPath: root });
    expect(resolved.store).toBeInstanceOf(BoardChangeStore);
    expect(resolved.store.kind).toBe('board');
    expect((resolved.store as BoardChangeStore).board).toEqual({
      repo: 'sagecool',
      url: 'https://board.example.test',
      configPath: path.join(root, '.agora.json'),
    });
    expect(toPlanningHome(resolved).kind).toBe('board');
    expect(toPlanningHome(resolved).root).toBe(root);
    expect(toRootOutput(resolved)).toEqual({ path: root, source: 'nearest' });
  });

  it('fails a board operation naming the board instead of falling back to files', async () => {
    fs.writeFileSync(path.join(root, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: 'http://127.0.0.1:1' }));
    process.env.AGORA_TOKEN = 'test-token';
    const resolved = await resolveOpenSpecRoot({ startPath: root });
    await expect(resolved.store.listChanges()).rejects.toBeInstanceOf(BoardUnreachableError);
    await expect(resolved.store.listChanges()).rejects.toThrow('board at http://127.0.0.1:1 unreachable');
    await expect(resolved.store.archiveChange('demo')).rejects.toBeInstanceOf(BoardUnreachableError);
  });

  it('refuses a declared board it cannot use rather than reading files', async () => {
    fs.writeFileSync(path.join(root, '.agora.json'), '{ not json');
    await expect(resolveOpenSpecRoot({ startPath: root })).rejects.toBeInstanceOf(BoardConfigError);

    fs.writeFileSync(path.join(root, '.agora.json'), JSON.stringify({ repo: 'sagecool' }));
    await expect(resolveOpenSpecRoot({ startPath: root })).rejects.toThrow(
      'names no board; set "url" in the file or AGORA_URL'
    );

    fs.writeFileSync(path.join(root, '.agora.json'), JSON.stringify({ url: 'https://board.example.test' }));
    await expect(resolveOpenSpecRoot({ startPath: root })).rejects.toThrow(
      'names no repository; set "repo" in the file or AGORA_REPO'
    );
  });

  it('lets AGORA_URL and AGORA_REPO override the file', () => {
    fs.writeFileSync(
      path.join(root, '.agora.json'),
      JSON.stringify({ repo: 'sagecool', url: 'https://one.example.test' })
    );
    expect(
      findBoardConfig(root, {
        AGORA_URL: 'https://two.example.test/',
        AGORA_REPO: 'other',
      })
    ).toEqual({
      repo: 'other',
      url: 'https://two.example.test',
      configPath: path.join(root, '.agora.json'),
    });
    expect(findBoardConfig(root, {})).toMatchObject({
      repo: 'sagecool',
      url: 'https://one.example.test',
    });
    expect(findBoardConfig(path.join(root, 'openspec'), {})).toBeNull();
  });
});
