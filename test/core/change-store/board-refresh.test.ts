import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardClient } from '../../../src/core/change-store/board-client.js';
import { BoardChangeStore } from '../../../src/core/change-store/board-change-store.js';
import { refreshChange } from '../../../src/core/change-store/board-migration.js';
import { startStubBoard, type RunningStubBoard } from '../../helpers/stub-board.js';

const noGit = async () => null;
const TASKS = ['## 1. Group', '', '- [ ] 1.1 First', '- [ ] 1.2 Second', '- [ ] 1.3 Third', ''].join('\n');

describe('board refresh', () => {
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
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-board-refresh-')));
    store = new BoardChangeStore({
      projectRoot: root,
      board: running.board,
      client: new BoardClient({ board: running.board, token: 't' }),
      git: noGit,
    });
    await store.createChange('demo');
    await store.writeArtifact('demo', 'proposal.md', '# Proposal\n');
    await store.writeArtifact('demo', 'design.md', '# Design\n');
    await store.writeArtifact('demo', 'tasks.md', TASKS);
    await store.completeTask('demo', 2);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const liveByArtifact = (artifact: string) => running.stub.live().find((tuple) => tuple.map.artifact === artifact)!;

  it('re-posts only the tuples expiring within seven days, keeping content and state', async () => {
    // Stub tuples expire in 90 (artefacts) or 30 (tasks) days from the stub's epoch; the clock says none is close.
    const now = new Date(Date.UTC(2026, 8, 29));
    const quiet = await refreshChange(store, 'demo', { now });
    expect(quiet.refreshed).toEqual([]);

    // Bring the design and task 3 within the window; leave the proposal, the tasks artefact and the other tasks alone.
    const design = liveByArtifact('design');
    const tasksArtefact = liveByArtifact('tasks');
    const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    running.stub.tuples.get(design.id)!.expires = soon;
    const taskIdsBefore = tasksArtefact.map.task_ids as string[];
    running.stub.tuples.get(taskIdsBefore[2])!.expires = soon;

    const result = await refreshChange(store, 'demo', { now });
    expect(result.refreshed.map((entry) => [entry.kind, entry.path, entry.previousId])).toEqual([
      ['artefact', 'design.md', design.id],
      ['task', 'tasks.md#3', taskIdsBefore[2]],
    ]);

    // The design is a new version with the same content; the old one is superseded.
    const designNow = liveByArtifact('design');
    expect(designNow.id).not.toBe(design.id);
    expect(designNow.links).toEqual([`supersedes:${design.id}`]);
    expect(await store.readArtifact('demo', 'design.md')).toBe('# Design\n');
    expect(running.stub.tuples.get(design.id)?.state).toBe('superseded');

    // Task 3 is a new open tuple superseding the old one; tasks 1 and 2 keep their ids and states.
    const tasks = await store.listTasks('demo');
    expect(tasks.map((task) => [task.ordinal, task.done])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(tasks[0].id).toBe(taskIdsBefore[0]);
    expect(tasks[1].id).toBe(taskIdsBefore[1]);
    expect(tasks[2].id).not.toBe(taskIdsBefore[2]);
    expect(running.stub.tuples.get(tasks[2].id)?.links).toContain(`supersedes:${taskIdsBefore[2]}`);
    // The tasks artefact was re-written to carry the new id, since its list changed.
    expect(liveByArtifact('tasks').map.task_ids).toEqual(tasks.map((task) => task.id));
    // Nothing else moved.
    expect(liveByArtifact('proposal').id).toBe(liveByArtifact('proposal').id);
    expect(running.stub.live().filter((tuple) => tuple.map.artifact === 'proposal')).toHaveLength(1);

    // A second refresh right after writes nothing.
    const again = await refreshChange(store, 'demo', { now });
    expect(again.refreshed).toEqual([]);
  });

  it('refreshes a completed task as a completed copy', async () => {
    const now = new Date(Date.UTC(2026, 8, 29));
    const tasksArtefact = liveByArtifact('tasks');
    const ids = tasksArtefact.map.task_ids as string[];
    running.stub.tuples.get(ids[1])!.expires = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const result = await refreshChange(store, 'demo', { now });
    expect(result.refreshed.map((entry) => entry.path)).toEqual(['tasks.md#2']);
    const tasks = await store.listTasks('demo');
    expect(tasks[1].done).toBe(true);
    expect(tasks[1].id).not.toBe(ids[1]);
    expect(running.stub.tuples.get(tasks[1].id)?.state).toBe('retired');
  });
});
