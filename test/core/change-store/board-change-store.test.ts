import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardClient } from '../../../src/core/change-store/board-client.js';
import {
  BoardChangeStore,
  metadataTextFromContent,
  renderMetadataContent,
} from '../../../src/core/change-store/board-change-store.js';
import { startStubBoard, type RunningStubBoard } from '../../helpers/stub-board.js';

const noGit = async () => null;

describe('BoardChangeStore metadata', () => {
  let running: RunningStubBoard;
  let root: string;
  let store: BoardChangeStore;

  beforeAll(async () => {
    running = await startStubBoard('sagecool');
  });

  afterAll(async () => {
    await running.close();
  });

  beforeEach(() => {
    running.stub.tuples.clear();
    running.stub.calls.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-board-store-')));
    store = new BoardChangeStore({
      projectRoot: root,
      board: running.board,
      client: new BoardClient({ board: running.board, token: 't' }),
      git: noGit,
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a change as one metadata tuple and no directory', async () => {
    const result = await store.createChange('add-search');

    expect(result).toEqual({
      schema: 'spec-driven',
      changeDir: path.join(root, 'openspec', 'changes', 'add-search'),
    });
    expect(fs.existsSync(path.join(root, 'openspec', 'changes'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'openspec', 'specs'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'openspec', 'config.yaml'), 'utf-8')).toBe('schema: spec-driven\n');

    const artefacts = running.stub.live().filter((tuple) => tuple.kind === 'artefact');
    expect(artefacts).toHaveLength(1);
    const [metadata] = artefacts;
    expect(metadata.id).toMatch(/^[a-z]{5}-[a-z]{5}-artefact-add-search-metadata$/);
    expect(metadata.subjects).toEqual(['change:add-search', 'repo:sagecool']);
    expect(metadata.map).toEqual({
      tags: ['topic:openspec'],
      sdd: 'openspec',
      schema: 'spec-driven',
      artifact: 'metadata',
      source: 'openspec/changes/add-search/.openspec.yaml',
      repo: 'sagecool',
      harness: 'openspec',
    });
    const today = new Date();
    const created = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(metadata.content).toBe(
      `add-search metadata: schema spec-driven, created ${created}.\n\n\`\`\`yaml\nschema: spec-driven\ncreated: ${created}\n\`\`\``
    );
    expect(await store.changeExists('add-search')).toBe(true);
    expect(await store.changeExists('other')).toBe(false);
    expect(await store.readMetadata('add-search')).toEqual({
      schema: 'spec-driven',
      created,
    });
    expect(await store.readMetadata('other')).toBeNull();
  });

  it('refuses a change that already exists on the board', async () => {
    await store.createChange('add-search');
    await expect(store.createChange('add-search')).rejects.toThrow(
      `Change 'add-search' already exists on the board at ${running.url}`
    );
    await expect(store.createChange('Not Kebab')).rejects.toThrow();
  });

  it('revises metadata as a new tuple that supersedes the live one, and reads markers from it', async () => {
    await store.createChange('add-search');
    const [first] = running.stub.live().filter((tuple) => tuple.map.artifact === 'metadata');
    expect(await store.readMarker('add-search', 'skip_specs')).toEqual({
      declared: false,
    });

    await store.writeMetadata('add-search', {
      schema: 'spec-driven',
      created: '2026-09-01',
      skip_specs: true,
    });

    const live = running.stub.live().filter((tuple) => tuple.map.artifact === 'metadata');
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(first.id);
    expect(live[0].links).toEqual([`supersedes:${first.id}`]);
    expect(running.stub.tuples.get(first.id)?.state).toBe('superseded');
    expect(await store.readMetadata('add-search')).toEqual({
      schema: 'spec-driven',
      created: '2026-09-01',
      skip_specs: true,
    });
    expect(await store.readMarker('add-search', 'skip_specs')).toEqual({
      declared: true,
    });
    expect(await store.readMarker('add-search', 'retire_capabilities')).toEqual({ declared: false });
    expect(await store.readMarker('other', 'skip_specs')).toEqual({
      declared: false,
    });
  });

  it('declares the conventions once before the first post', async () => {
    await store.createChange('one');
    await store.createChange('two');
    const notes = running.stub.calls.filter(
      (call) => call.verb === 'post' && /^(key|scheme|concept)-/.test(String(call.body.id))
    );
    expect(notes).toHaveLength(12);
    const firstPost = running.stub.calls.find((call) => call.verb === 'post');
    expect(firstPost).toMatchObject({ verb: 'post', body: { id: 'key-harness' } });
  });

  it('renders and reads the metadata body round trip', () => {
    const content = renderMetadataContent(
      'x',
      { schema: 'spec-driven', created: '2026-09-01' },
      'schema: spec-driven\ncreated: 2026-09-01\n'
    );
    expect(content).toBe(
      'x metadata: schema spec-driven, created 2026-09-01.\n\n```yaml\nschema: spec-driven\ncreated: 2026-09-01\n```'
    );
    expect(metadataTextFromContent(content)).toBe('schema: spec-driven\ncreated: 2026-09-01\n');
    expect(metadataTextFromContent('summary\n\nschema: spec-driven\n')).toBe('schema: spec-driven\n');
  });
});
