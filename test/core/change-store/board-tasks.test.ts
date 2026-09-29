import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardClient } from '../../../src/core/change-store/board-client.js';
import { BoardChangeStore, renderTasksWithState } from '../../../src/core/change-store/board-change-store.js';
import { startStubBoard, type RunningStubBoard } from '../../helpers/stub-board.js';

const noGit = async () => null;

const SEVEN = [
  '## 1. First group',
  '',
  '- [ ] 1.1 Fork the repository',
  '- [ ] 1.2 Rename the package',
  '- [ ] 1.3 Publish the baseline',
  '',
  '## 2. Second group',
  '',
  '- [ ] 2.1 Define the store',
  '- [ ] 2.2 Remove layout assumptions',
  '- [ ] 2.3 Select the store',
  '- [ ] 2.4 Add the client',
  '',
].join('\n');

describe('BoardChangeStore tasks', () => {
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
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-board-tasks-')));
    store = new BoardChangeStore({
      projectRoot: root,
      board: running.board,
      client: new BoardClient({ board: running.board, token: 't' }),
      git: noGit,
    });
    await store.createChange('demo');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const taskTuples = () => [...running.stub.tuples.values()].filter((tuple) => tuple.kind === 'task');
  const tasksArtefact = () => running.stub.live().find((tuple) => tuple.map.artifact === 'tasks')!;

  it('writes seven items as seven open task tuples that derive from the tasks artefact', async () => {
    const written = await store.writeArtifact('demo', 'tasks.md', SEVEN);

    const artefact = tasksArtefact();
    expect(artefact.id).toBe(written.id);
    expect(artefact.id).toMatch(/^[a-z]{5}-[a-z]{5}-artefact-demo-tasks$/);
    const tasks = taskTuples();
    expect(tasks).toHaveLength(7);
    expect(artefact.map.task_ids).toEqual(tasks.map((tuple) => tuple.id));
    tasks.forEach((tuple, index) => {
      expect(tuple.state).toBe('open');
      expect(tuple.links).toEqual([`derives-from:${artefact.id}`]);
      expect(tuple.subjects).toEqual(['change:demo', 'repo:sagecool']);
      expect(tuple.map).toMatchObject({
        sdd: 'openspec',
        schema: 'spec-driven',
        task: index + 1,
        source: `openspec/changes/demo/tasks.md#${index + 1}`,
        harness: 'openspec',
      });
    });
    expect(tasks[3].content).toBe('2.1 Define the store');

    const listed = await store.listTasks('demo');
    expect(listed.map((task) => [task.ordinal, task.description, task.done])).toEqual([
      [1, '1.1 Fork the repository', false],
      [2, '1.2 Rename the package', false],
      [3, '1.3 Publish the baseline', false],
      [4, '2.1 Define the store', false],
      [5, '2.2 Remove layout assumptions', false],
      [6, '2.3 Select the store', false],
      [7, '2.4 Add the client', false],
    ]);
    expect(listed.map((task) => task.id)).toEqual(artefact.map.task_ids);
    expect(await store.readArtifact('demo', 'tasks.md')).toBe(SEVEN);
  });

  it('completes item 3: progress reads one of seven and the rendered tasks show it checked', async () => {
    await store.writeArtifact('demo', 'tasks.md', SEVEN);

    const completed = await store.completeTask('demo', 3);
    expect(completed).toMatchObject({
      ordinal: 3,
      description: '1.3 Publish the baseline',
      done: true,
    });
    expect(running.stub.tuples.get(completed.id)?.state).toBe('retired');

    const tasks = await store.listTasks('demo');
    expect(tasks.filter((task) => task.done).map((task) => task.ordinal)).toEqual([3]);
    expect(tasks).toHaveLength(7);
    expect(await store.readArtifact('demo', 'tasks.md')).toBe(
      SEVEN.replace('- [ ] 1.3 Publish the baseline', '- [x] 1.3 Publish the baseline')
    );

    await expect(store.completeTask('demo', 9)).rejects.toThrow("Task 9 not found in change 'demo'");
  });

  it('takes and releases a task through the board lease', async () => {
    await store.writeArtifact('demo', 'tasks.md', SEVEN);
    const taken = await store.takeTask('demo', 2);
    expect(taken).toMatchObject({ ordinal: 2, taken: true, done: false });
    expect(running.stub.tuples.get(taken.id)?.lease).toBe(running.stub.owner);
    expect((await store.listTasks('demo'))[1].taken).toBe(true);

    const released = await store.releaseTask('demo', 2);
    expect(released.taken).toBe(false);
    expect(running.stub.tuples.get(taken.id)?.lease).toBeUndefined();
  });

  it('revises the list: five kept with ids and states, two dropped and archived, one new and open', async () => {
    await store.writeArtifact('demo', 'tasks.md', SEVEN);
    const before = await store.listTasks('demo');
    await store.completeTask('demo', 3);
    const firstArtefact = tasksArtefact();

    // The new item goes first, so it shares no ordinal with a dropped one:
    // kept items shift down and are matched by text, not position.
    const revised = [
      '## 0. Before anything',
      '',
      '- [ ] 0.1 Wire the CI job',
      '',
      '## 1. First group',
      '',
      '- [ ] 1.1 Fork the repository',
      '- [x] 1.2 Rename the package',
      '- [ ] 1.3 Publish the baseline',
      '',
      '## 2. Second group',
      '',
      '- [ ] 2.1 Define the store',
      '- [ ] 2.2 Remove layout assumptions',
      '',
    ].join('\n');
    const written = await store.writeArtifact('demo', 'tasks.md', revised, {
      base: firstArtefact.id,
    });

    const artefact = tasksArtefact();
    expect(artefact.id).toBe(written.id);
    expect(artefact.links).toEqual([`supersedes:${firstArtefact.id}`]);
    expect(running.stub.tuples.get(firstArtefact.id)?.state).toBe('superseded');

    const after = await store.listTasks('demo');
    expect(after.map((task) => [task.ordinal, task.description, task.done])).toEqual([
      [1, '0.1 Wire the CI job', false],
      [2, '1.1 Fork the repository', false],
      // The checked box in the written text is not a completion.
      [3, '1.2 Rename the package', false],
      [4, '1.3 Publish the baseline', true],
      [5, '2.1 Define the store', false],
      [6, '2.2 Remove layout assumptions', false],
    ]);
    // Kept items keep their ids and states across the shift.
    expect(after.slice(1).map((task) => task.id)).toEqual(before.slice(0, 5).map((task) => task.id));
    // Dropped items are archived, readable by id, not counted.
    for (const dropped of before.slice(5)) {
      const tuple = running.stub.tuples.get(dropped.id)!;
      expect(tuple.state).toBe('retired');
      expect(tuple.archived).toBe(true);
    }
    // The new item is a fresh open tuple deriving from the new artefact.
    const added = running.stub.tuples.get(after[0].id)!;
    expect(added.state).toBe('open');
    expect(added.links).toEqual([`derives-from:${artefact.id}`]);
    expect(added.map.task).toBe(1);
    expect(artefact.map.task_ids).toEqual(after.map((task) => task.id));
  });

  it('treats an unmatched item at an unmatched ordinal as an edit that inherits the state', async () => {
    await store.writeArtifact('demo', 'tasks.md', SEVEN);
    const before = await store.listTasks('demo');
    await store.completeTask('demo', 2);

    const edited = SEVEN.replace('- [ ] 1.2 Rename the package', '- [ ] 1.2 Rename the package to @sagecool/openspec');
    await store.writeArtifact('demo', 'tasks.md', edited);

    const after = await store.listTasks('demo');
    expect(after[1]).toMatchObject({
      ordinal: 2,
      description: '1.2 Rename the package to @sagecool/openspec',
      done: true,
    });
    expect(after[1].id).not.toBe(before[1].id);
    expect(running.stub.tuples.get(after[1].id)?.links).toContain(`supersedes:${before[1].id}`);
    expect(after.filter((task, index) => index !== 1).map((task) => task.id)).toEqual(
      before.filter((task, index) => index !== 1).map((task) => task.id)
    );
  });

  it('completes checked items only when importing', async () => {
    const checked = SEVEN.replace('- [ ] 1.1 Fork the repository', '- [x] 1.1 Fork the repository');
    await store.writeArtifact('demo', 'tasks.md', checked, {
      importCheckboxes: true,
    });
    const tasks = await store.listTasks('demo');
    expect(tasks.filter((task) => task.done).map((task) => task.ordinal)).toEqual([1]);
  });

  it('renders checkboxes from state', () => {
    const rendered = renderTasksWithState('- [ ] a\ntext\n- [x] b\n- [ ] c', [
      { ordinal: 1, id: '1', description: 'a', done: true },
      { ordinal: 2, id: '2', description: 'b', done: false },
      { ordinal: 3, id: '3', description: 'c', done: false },
    ]);
    expect(rendered).toBe('- [x] a\ntext\n- [ ] b\n- [ ] c');
  });
});
