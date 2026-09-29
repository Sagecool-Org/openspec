import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;
const env = { AGORA_TOKEN: 'stub-token' };

async function scaffoldBoardProject(): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-board-read-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: running.url }));
  return projectDir;
}

/** Posts an artefact straight onto the stub, as the store would. */
function postArtefact(
  name: string,
  relativePath: string,
  artifact: string,
  content: string,
  extra: Record<string, unknown> = {}
) {
  running.stub.handle('post', {
    id: `seed-${name}-${artifact}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'artefact',
    content,
    subjects: [`change:${name}`, 'repo:sagecool'],
    sdd: 'openspec',
    schema: 'spec-driven',
    artifact,
    source: `openspec/changes/${name}/${relativePath}`,
    ...extra,
  });
}

beforeAll(async () => {
  running = await startStubBoard('sagecool');
});

afterAll(async () => {
  await running.close();
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('read commands on a board-backed repository', { timeout: 60_000 }, () => {
  it('status of a partly planned change: proposal done, specs and design ready, tasks blocked', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldBoardProject();
    postArtefact(
      'planned',
      '.openspec.yaml',
      'metadata',
      'planned metadata: schema spec-driven.\n\n```yaml\nschema: spec-driven\n```'
    );
    postArtefact('planned', 'proposal.md', 'proposal', 'planned proposal: Proposal\n\n# Proposal\n');

    const result = await runCLI(['status', '--change', 'planned', '--json'], {
      cwd,
      env,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.planningHome.kind).toBe('board');
    const byId = Object.fromEntries(
      payload.artifacts.map((artifact: { id: string; status: string }) => [artifact.id, artifact.status])
    );
    expect(byId).toEqual({
      proposal: 'done',
      specs: 'ready',
      design: 'ready',
      tasks: 'blocked',
    });
    await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();
  });

  it('validation of a zero-delta change fails with the upstream zero-delta error', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldBoardProject();
    postArtefact(
      'zero',
      '.openspec.yaml',
      'metadata',
      'zero metadata: schema spec-driven.\n\n```yaml\nschema: spec-driven\n```'
    );
    postArtefact('zero', 'proposal.md', 'proposal', 'zero proposal: Proposal\n\n# Proposal\n');

    const result = await runCLI(['validate', 'zero', '--json'], { cwd, env });
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.items[0].valid).toBe(false);
    const messages = payload.items[0].issues.map((issue: { message: string }) => issue.message).join('\n');
    expect(messages).toMatch(/skip_specs/);
    await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();
  });

  it('lists board changes with their task progress', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldBoardProject();
    postArtefact(
      'listed',
      '.openspec.yaml',
      'metadata',
      'listed metadata: schema spec-driven.\n\n```yaml\nschema: spec-driven\n```'
    );
    postArtefact(
      'bare',
      '.openspec.yaml',
      'metadata',
      'bare metadata: schema spec-driven.\n\n```yaml\nschema: spec-driven\n```'
    );
    for (const ordinal of [1, 2, 3]) {
      running.stub.handle('post', {
        id: `seed-task-${ordinal}`,
        kind: 'task',
        content: `1.${ordinal} Task ${ordinal}`,
        subjects: ['change:listed', 'repo:sagecool'],
        task: ordinal,
      });
    }
    running.stub.handle('complete', { id: 'seed-task-2' });

    const result = await runCLI(['list', '--json', '--sort', 'name'], {
      cwd,
      env,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(
      payload.changes.map((change: Record<string, unknown>) => [
        change.name,
        change.completedTasks,
        change.totalTasks,
        change.status,
      ])
    ).toEqual([
      ['bare', 0, 0, 'no-tasks'],
      ['listed', 1, 3, 'in-progress'],
    ]);
  });

  it('shows a board change from its proposal', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldBoardProject();
    postArtefact(
      'shown',
      '.openspec.yaml',
      'metadata',
      'shown metadata: schema spec-driven.\n\n```yaml\nschema: spec-driven\n```'
    );
    postArtefact('shown', 'proposal.md', 'proposal', 'shown proposal: Show me\n\n# Show me\n\n## Why\n\nBecause.\n');

    const result = await runCLI(['show', 'shown', '--type', 'change'], {
      cwd,
      env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('# Show me\n\n## Why\n\nBecause.\n\n');
    await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();
  });
});
