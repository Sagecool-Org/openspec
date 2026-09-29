import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardClient } from '../../../src/core/change-store/board-client.js';
import {
  BoardChangeStore,
  StaleArtifactError,
  artifactKeysFor,
  artifactSummary,
} from '../../../src/core/change-store/board-change-store.js';
import { startStubBoard, type RunningStubBoard } from '../../helpers/stub-board.js';

const noGit = async () => null;

describe('BoardChangeStore artefacts', () => {
  let running: RunningStubBoard;
  let root: string;
  let store: BoardChangeStore;

  beforeAll(async () => {
    running = await startStubBoard('sagecool');
  });

  afterAll(async () => {
    await running.close();
  });

  beforeEach(async () => {
    running.stub.tuples.clear();
    running.stub.calls.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-board-artifacts-')));
    store = new BoardChangeStore({
      projectRoot: root,
      board: running.board,
      client: new BoardClient({ board: running.board, token: 't' }),
      git: noGit,
    });
    await store.createChange('add-search');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const liveArtefacts = () => running.stub.live().filter((tuple) => tuple.kind === 'artefact');

  it('posts a first write as one tuple whose body is the summary over the markdown', async () => {
    const written = await store.writeArtifact(
      'add-search',
      'proposal.md',
      '# Add search\n\n## Why\n\nFinding things.\n'
    );
    const tuple = liveArtefacts().find((candidate) => candidate.map.artifact === 'proposal');
    expect(tuple).toBeDefined();
    expect(written).toEqual({ id: tuple!.id });
    expect(tuple!.id).toMatch(/^[a-z]{5}-[a-z]{5}-artefact-add-search-proposal$/);
    expect(tuple!.subjects).toEqual(['change:add-search', 'repo:sagecool']);
    expect(tuple!.links).toEqual([]);
    expect(tuple!.map).toEqual({
      tags: ['topic:openspec'],
      sdd: 'openspec',
      schema: 'spec-driven',
      artifact: 'proposal',
      source: 'openspec/changes/add-search/proposal.md',
      repo: 'sagecool',
      harness: 'openspec',
    });
    expect(tuple!.content).toBe('add-search proposal: Add search\n\n# Add search\n\n## Why\n\nFinding things.\n');
    expect(await store.readArtifact('add-search', 'proposal.md')).toBe('# Add search\n\n## Why\n\nFinding things.\n');
    expect(await store.readArtifact('add-search', 'design.md')).toBeNull();
  });

  it('revises as a new tuple that supersedes the live one and leaves the other artefacts alone', async () => {
    const proposal = await store.writeArtifact('add-search', 'proposal.md', '# Proposal\n');
    const design = await store.writeArtifact('add-search', 'design.md', '# Design\n\nFirst cut.\n');
    const spec = await store.writeArtifact('add-search', 'specs/search/spec.md', '## ADDED Requirements\n');

    const revised = await store.writeArtifact('add-search', 'design.md', '# Design\n\nSecond cut.\n', {
      base: design.id,
    });

    expect(revised.id).not.toBe(design.id);
    const live = liveArtefacts();
    expect(live.map((tuple) => tuple.id).sort()).toEqual(
      [proposal.id, spec.id, revised.id, live.find((tuple) => tuple.map.artifact === 'metadata')!.id].sort()
    );
    expect(running.stub.tuples.get(design.id)?.state).toBe('superseded');
    expect(running.stub.tuples.get(revised.id)?.links).toEqual([`supersedes:${design.id}`]);
    expect(await store.readArtifact('add-search', 'design.md')).toBe('# Design\n\nSecond cut.\n');
    expect(running.stub.tuples.get(spec.id)?.map).toMatchObject({
      artifact: 'spec',
      capability: 'search',
      source: 'openspec/changes/add-search/specs/search/spec.md',
    });
  });

  it('refuses a stale base naming the live id, unless forced', async () => {
    const first = await store.writeArtifact('add-search', 'design.md', '# Design v1\n');
    const second = await store.writeArtifact('add-search', 'design.md', '# Design v2\n', { base: first.id });

    const stale = await store
      .writeArtifact('add-search', 'design.md', '# Design from an old read\n', {
        base: first.id,
      })
      .catch((error) => error);
    expect(stale).toBeInstanceOf(StaleArtifactError);
    expect(stale.message).toBe(
      `design.md of change 'add-search' has moved on: the live version is ${second.id}, not ${first.id}. ` +
        `Re-read it and write again with --base ${second.id}, or pass --force.`
    );
    expect(stale.liveId).toBe(second.id);
    expect(await store.readArtifact('add-search', 'design.md')).toBe('# Design v2\n');

    const forced = await store.writeArtifact('add-search', 'design.md', '# Design forced\n', {
      base: first.id,
      force: true,
    });
    expect(forced.id).not.toBe(second.id);
    expect(running.stub.tuples.get(forced.id)?.links).toEqual([`supersedes:${second.id}`]);
    expect(await store.readArtifact('add-search', 'design.md')).toBe('# Design forced\n');
  });

  it('refuses a base for an artefact with no live version', async () => {
    await expect(
      store.writeArtifact('add-search', 'design.md', '# Design\n', {
        base: 'gone-gone-artefact-add-search-design',
      })
    ).rejects.toThrow("design.md of change 'add-search' no longer has a live version to revise");
  });

  it('routes metadata written by path through the metadata contract', async () => {
    const before = liveArtefacts().find((tuple) => tuple.map.artifact === 'metadata')!;
    expect(await store.readArtifact('add-search', '.openspec.yaml')).toMatch(
      /^schema: spec-driven\ncreated: \d{4}-\d{2}-\d{2}\n$/
    );

    const written = await store.writeArtifact(
      'add-search',
      '.openspec.yaml',
      'schema: spec-driven\nskip_specs: true\n'
    );
    expect(written.id).not.toBe(before.id);
    expect(await store.readMarker('add-search', 'skip_specs')).toEqual({
      declared: true,
    });
    await expect(store.writeArtifact('add-search', '.openspec.yaml', 'schema: nope\n')).rejects.toThrow(/nope/);
  });

  it('derives artefact keys and summaries from the path and the markdown', () => {
    expect(artifactKeysFor('proposal.md')).toEqual({ artifact: 'proposal' });
    expect(artifactKeysFor('specs/board-change-store/spec.md')).toEqual({
      artifact: 'spec',
      capability: 'board-change-store',
    });
    expect(artifactKeysFor('README.md')).toEqual({ artifact: 'readme' });
    expect(artifactKeysFor('.openspec.yaml')).toEqual({ artifact: 'metadata' });
    expect(artifactSummary('x', 'proposal.md', '\n\n## Why\n\nBecause.\n')).toBe('x proposal: Why');
    expect(artifactSummary('x', 'specs/search/spec.md', '## ADDED Requirements')).toBe(
      'search delta spec: ADDED Requirements'
    );
    expect(artifactSummary('x', 'tasks.md', '')).toBe('x tasks');
    expect(artifactSummary('x', 'design.md', `# ${'long '.repeat(60)}`).length).toBe(200);
  });
});
