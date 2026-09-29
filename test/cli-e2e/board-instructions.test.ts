import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;
const boardEnv = { AGORA_TOKEN: 'stub-token' };

const PROPOSAL = '# Demo\n\n## Why\n\nBecause.\n';
const TASKS = ['## 1. Group', '', '- [ ] 1.1 First', '- [ ] 1.2 Second', '- [ ] 1.3 Third', ''].join('\n');

async function scaffoldProject(withBoard: boolean): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-board-instructions-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(projectDir, 'proposal-input.md'), PROPOSAL);
  await fs.writeFile(path.join(projectDir, 'tasks-input.md'), TASKS);
  if (withBoard) {
    await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: running.url }));
  }
  return projectDir;
}

async function plan(cwd: string, env: Record<string, string>): Promise<void> {
  expect((await runCLI(['new', 'change', 'demo', '--json'], { cwd, env })).exitCode).toBe(0);
  expect(
    (await runCLI(['change', 'write', 'demo', 'proposal', '--file', 'proposal-input.md'], { cwd, env })).exitCode
  ).toBe(0);
  expect((await runCLI(['change', 'write', 'demo', 'tasks', '--file', 'tasks-input.md'], { cwd, env })).exitCode).toBe(
    0
  );
  expect((await runCLI(['task', 'complete', 'demo', '2'], { cwd, env })).exitCode).toBe(0);
}

beforeAll(async () => {
  running = await startStubBoard('sagecool');
});

afterAll(async () => {
  await running.close();
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('instructions on a board change', { timeout: 120_000 }, () => {
  it('apply instructions report board progress and list the tasks with ordinals and ids', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldProject(true);
    await plan(cwd, boardEnv);

    const result = await runCLI(['instructions', 'apply', '--change', 'demo', '--json'], { cwd, env: boardEnv });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.progress).toEqual({ total: 3, complete: 1, remaining: 2 });
    expect(json.tasks).toHaveLength(3);
    const open = json.tasks.filter((task: { done: boolean }) => !task.done);
    expect(open.map((task: { ordinal: number; description: string }) => [task.ordinal, task.description])).toEqual([
      [1, '1.1 First'],
      [3, '1.3 Third'],
    ]);
    for (const task of open) expect(task.id).toMatch(/^[a-z]{5}-[a-z]{5}-task-demo-task-\d$/);
    // As upstream: apply does not require specs or design, so the change is ready with them still to build.
    expect(json.state).toBe('ready');
    expect(json).not.toHaveProperty('missingArtifacts');
    expect(json.missingPrerequisites).toEqual(['specs', 'design']);
    expect(json.warnings).toHaveLength(1);
    const changeDir = path.join(await fs.realpath(cwd), 'openspec', 'changes', 'demo');
    expect(json.contextFiles).toEqual({
      proposal: [path.join(changeDir, 'proposal.md')],
      tasks: [path.join(changeDir, 'tasks.md')],
    });
    expect(json.contextContent.proposal).toEqual([{ path: path.join(changeDir, 'proposal.md'), content: PROPOSAL }]);
    expect(json.contextContent.tasks[0].content).toBe(TASKS.replace('- [ ] 1.2 Second', '- [x] 1.2 Second'));
    await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();
  });

  it('artifact instructions carry the dependency content and a board destination with the base id', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldProject(true);
    await plan(cwd, boardEnv);

    const first = JSON.parse(
      (
        await runCLI(['instructions', 'design', '--change', 'demo', '--json'], {
          cwd,
          env: boardEnv,
        })
      ).stdout
    );
    expect(
      first.dependencies.map((dependency: { id: string; done: boolean; content?: string }) => [
        dependency.id,
        dependency.done,
        dependency.content,
      ])
    ).toEqual([['proposal', true, PROPOSAL]]);
    expect(first.destination).toEqual({
      kind: 'board',
      change: 'demo',
      artifact: 'design',
    });
    expect(first.existingOutputPaths).toEqual([]);

    await fs.writeFile(path.join(cwd, 'design-input.md'), '# Design\n');
    const written = JSON.parse(
      (
        await runCLI(['change', 'write', 'demo', 'design', '--file', 'design-input.md', '--json'], {
          cwd,
          env: boardEnv,
        })
      ).stdout
    );
    const second = JSON.parse(
      (
        await runCLI(['instructions', 'design', '--change', 'demo', '--json'], {
          cwd,
          env: boardEnv,
        })
      ).stdout
    );
    expect(second.destination).toEqual({
      kind: 'board',
      change: 'demo',
      artifact: 'design',
      baseId: written.id,
    });
    expect(second.existingOutputPaths).toHaveLength(1);

    const specs = JSON.parse(
      (
        await runCLI(['instructions', 'specs', '--change', 'demo', '--json'], {
          cwd,
          env: boardEnv,
        })
      ).stdout
    );
    expect(specs.destination).toEqual({
      kind: 'board',
      change: 'demo',
      artifact: 'specs',
    });
  });

  it('archive inputs carry the progress archive would refuse on', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldProject(true);
    await plan(cwd, boardEnv);
    const json = JSON.parse(
      (await runCLI(['instructions', 'archive', '--change', 'demo', '--json'], { cwd, env: boardEnv })).stdout
    );
    expect(json.progress).toEqual({ total: 3, complete: 1, remaining: 2 });
    expect(json.tasks.map((task: { ordinal: number; done: boolean }) => [task.ordinal, task.done])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('keeps the file-store JSON shape unchanged', async () => {
    const cwd = await scaffoldProject(false);
    await plan(cwd, {});
    const apply = JSON.parse(
      (
        await runCLI(['instructions', 'apply', '--change', 'demo', '--json'], {
          cwd,
        })
      ).stdout
    );
    expect(Object.keys(apply).sort()).toEqual(
      [
        'changeDir',
        'changeName',
        'contextFiles',
        'instruction',
        'missingPrerequisites',
        'progress',
        'root',
        'schemaName',
        'state',
        'tasks',
        'warnings',
      ].sort()
    );
    expect(apply.progress).toEqual({ total: 3, complete: 1, remaining: 2 });
    expect(apply.tasks).toEqual([
      { id: '1', description: '1.1 First', done: false },
      { id: '2', description: '1.2 Second', done: true },
      { id: '3', description: '1.3 Third', done: false },
    ]);
    const design = JSON.parse(
      (
        await runCLI(['instructions', 'design', '--change', 'demo', '--json'], {
          cwd,
        })
      ).stdout
    );
    expect(design).not.toHaveProperty('destination');
    expect(design.dependencies[0]).not.toHaveProperty('content');
    const archive = JSON.parse(
      (await runCLI(['instructions', 'archive', '--change', 'demo', '--json'], { cwd })).stdout
    );
    expect(Object.keys(archive).sort()).toEqual(['changeName', 'root']);
  });

  it('refuses a board artefact over the size cap', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldProject(true);
    expect(
      (
        await runCLI(['new', 'change', 'demo', '--json'], {
          cwd,
          env: boardEnv,
        })
      ).exitCode
    ).toBe(0);
    await fs.writeFile(path.join(cwd, 'huge.md'), `# Huge\n\n${'x'.repeat(50 * 1024)}\n`);
    const result = await runCLI(['change', 'write', 'demo', 'design', '--file', 'huge.md'], { cwd, env: boardEnv });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/bounded at 51200 bytes/);
  });
});
