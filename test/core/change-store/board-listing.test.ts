import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardClient } from '../../../src/core/change-store/board-client.js';
import { BoardChangeStore } from '../../../src/core/change-store/board-change-store.js';
import { generatesMatcher, matchOutputs } from '../../../src/core/change-store/generates-glob.js';
import { loadChangeContextFor, withChangeOnDisk } from '../../../src/core/change-store/context.js';
import { formatChangeStatus } from '../../../src/core/artifact-graph/instruction-loader.js';
import { startStubBoard, type RunningStubBoard } from '../../helpers/stub-board.js';

const noGit = async () => null;

describe('generates patterns against stored outputs', () => {
  it('matches like the file glob does', () => {
    expect(generatesMatcher('proposal.md')('proposal.md')).toBe(true);
    expect(generatesMatcher('proposal.md')('design.md')).toBe(false);
    expect(generatesMatcher('specs/**/spec.md')('specs/search/spec.md')).toBe(true);
    expect(generatesMatcher('specs/**/spec.md')('specs/a/b/spec.md')).toBe(true);
    expect(generatesMatcher('specs/**/spec.md')('specs/spec.md')).toBe(true);
    expect(generatesMatcher('specs/**/spec.md')('specs/search/notes.md')).toBe(false);
    expect(generatesMatcher('**/tasks.md')('tasks.md')).toBe(true);
    expect(generatesMatcher('**/tasks.md')('phases/one/tasks.md')).toBe(true);
    expect(generatesMatcher('*.md')('a.md')).toBe(true);
    expect(generatesMatcher('*.md')('dir/a.md')).toBe(false);
    expect(matchOutputs(['tasks.md', 'specs/b/spec.md', 'specs/a/spec.md', 'proposal.md'], 'specs/**/spec.md')).toEqual(
      ['specs/a/spec.md', 'specs/b/spec.md']
    );
  });
});

describe('BoardChangeStore listing and outputs', () => {
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
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-board-listing-')));
    fs.mkdirSync(path.join(root, 'openspec', 'specs', 'search'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'openspec', 'specs', 'search', 'spec.md'),
      '# search\n\n## Purpose\n\nx\n\n## Requirements\n'
    );
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

  it('lists the changes with a live metadata tuple in this repository', async () => {
    expect(await store.listChanges()).toEqual([]);
    await store.createChange('beta');
    await store.createChange('alpha');
    // Another repository's change on the same board is not ours.
    running.stub.handle('post', {
      id: 'other-repo-artefact-gamma-metadata',
      kind: 'artefact',
      content: 'gamma metadata',
      subjects: ['change:gamma', 'repo:elsewhere'],
      artifact: 'metadata',
    });
    expect(await store.listChanges()).toEqual(['alpha', 'beta']);
  });

  it('reports a snapshot, outputs and deltas from the live tuples', async () => {
    await store.createChange('add-search');
    await store.writeArtifact('add-search', 'proposal.md', '# Proposal\n');
    await store.writeArtifact('add-search', 'specs/search/spec.md', '## MODIFIED Requirements\n');
    await store.writeArtifact('add-search', 'specs/shortlists/spec.md', '## ADDED Requirements\n');

    const snapshot = await store.snapshot('add-search');
    expect(snapshot.exists).toBe(true);
    expect(snapshot.metadata).toMatchObject({ schema: 'spec-driven' });
    expect(snapshot.outputs).toEqual([
      '.openspec.yaml',
      'proposal.md',
      'specs/search/spec.md',
      'specs/shortlists/spec.md',
    ]);
    expect(await store.snapshot('missing')).toEqual({
      exists: false,
      metadata: null,
      outputs: [],
    });

    const changeDir = path.join(root, 'openspec', 'changes', 'add-search');
    expect(await store.resolveOutputs('add-search', 'proposal.md')).toEqual([path.join(changeDir, 'proposal.md')]);
    expect(await store.resolveOutputs('add-search', 'specs/**/spec.md')).toEqual([
      path.join(changeDir, 'specs', 'search', 'spec.md'),
      path.join(changeDir, 'specs', 'shortlists', 'spec.md'),
    ]);
    expect(await store.outputExists('add-search', 'design.md')).toBe(false);
    expect(await store.outputExists('add-search', 'proposal.md')).toBe(true);

    expect(await store.listDeltaSpecs('add-search')).toEqual([
      {
        id: 'search',
        specFile: path.join(changeDir, 'specs', 'search', 'spec.md'),
      },
      {
        id: 'shortlists',
        specFile: path.join(changeDir, 'specs', 'shortlists', 'spec.md'),
      },
    ]);
    expect((await store.listUnreadDeltas('add-search')).map((delta) => delta.id)).toEqual(['shortlists']);
    expect(await store.hasAnyContent('add-search')).toBe(true);
    expect(await store.changeLastModified('add-search')).toBeInstanceOf(Date);
    expect(await store.changeLastModified('missing')).toBeNull();
  });

  it('holds no content when only metadata exists', async () => {
    await store.createChange('bare');
    expect(await store.hasAnyContent('bare')).toBe(false);
    expect(await store.listDeltaSpecs('bare')).toEqual([]);
  });

  it('lists tasks by ordinal from task tuples, completed ones included', async () => {
    await store.createChange('add-search');
    for (const [ordinal, text] of [
      [2, '1.2 Second'],
      [1, '1.1 First'],
      [3, '1.3 Third'],
    ] as const) {
      running.stub.handle('post', {
        id: `stub-task-${ordinal}`,
        kind: 'task',
        content: text,
        subjects: ['change:add-search', 'repo:sagecool'],
        task: ordinal,
      });
    }
    running.stub.handle('complete', { id: 'stub-task-1' });
    expect(await store.listTasks('add-search')).toEqual([
      { ordinal: 1, id: 'stub-task-1', description: '1.1 First', done: true },
      { ordinal: 2, id: 'stub-task-2', description: '1.2 Second', done: false },
      { ordinal: 3, id: 'stub-task-3', description: '1.3 Third', done: false },
    ]);
  });

  it('loads the artifact-graph context from a snapshot: proposal done, specs and design ready, tasks blocked', async () => {
    await store.createChange('add-search');
    await store.writeArtifact('add-search', 'proposal.md', '# Proposal\n');

    const context = await loadChangeContextFor(store, 'add-search');
    expect(context.snapshot?.outputs).toEqual(['.openspec.yaml', 'proposal.md']);
    expect([...context.completed]).toEqual(['proposal']);

    const status = formatChangeStatus(context);
    const byId = Object.fromEntries(status.artifacts.map((artifact) => [artifact.id, artifact.status]));
    expect(byId).toEqual({
      proposal: 'done',
      specs: 'ready',
      design: 'ready',
      tasks: 'blocked',
    });
    expect(status.artifactPaths.proposal.existingOutputPaths).toEqual([
      path.join(root, 'openspec', 'changes', 'add-search', 'proposal.md'),
    ]);
    expect(status.artifactPaths.specs.existingOutputPaths).toEqual([]);
    expect(fs.existsSync(path.join(root, 'openspec', 'changes'))).toBe(false);
  });

  it('exports the change to a temporary root for file-shaped commands and removes it after', async () => {
    await store.createChange('add-search');
    await store.writeArtifact('add-search', 'proposal.md', '# Proposal\n\nBody.\n');
    await store.writeArtifact('add-search', 'specs/search/spec.md', '## MODIFIED Requirements\n');

    let seenRoot = '';
    await withChangeOnDisk(store, 'add-search', async (onDisk) => {
      seenRoot = onDisk.path;
      const changeDir = path.join(onDisk.changesDir, 'add-search');
      expect(fs.readFileSync(path.join(changeDir, 'proposal.md'), 'utf-8')).toBe('# Proposal\n\nBody.\n');
      expect(fs.readFileSync(path.join(changeDir, 'specs', 'search', 'spec.md'), 'utf-8')).toBe(
        '## MODIFIED Requirements\n'
      );
      expect(fs.readFileSync(path.join(changeDir, '.openspec.yaml'), 'utf-8')).toMatch(/^schema: spec-driven\n/);
      expect(fs.realpathSync(path.join(onDisk.path, 'openspec', 'specs'))).toBe(path.join(root, 'openspec', 'specs'));
      expect(onDisk.specsDir).toBe(path.join(root, 'openspec', 'specs'));
    });
    expect(seenRoot).not.toBe(root);
    expect(fs.existsSync(seenRoot)).toBe(false);
    expect(fs.existsSync(path.join(root, 'openspec', 'changes'))).toBe(false);
  });
});
