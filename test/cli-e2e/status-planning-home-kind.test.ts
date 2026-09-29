import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;

async function scaffoldProject(withBoard: boolean): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-planning-home-kind-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  if (withBoard) {
    await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: running.url }));
    running.stub.handle('post', {
      id: 'seed-demo-metadata',
      kind: 'artefact',
      content: 'demo metadata: schema spec-driven.\n\n```yaml\nschema: spec-driven\n```',
      subjects: ['change:demo', 'repo:sagecool'],
      sdd: 'openspec',
      schema: 'spec-driven',
      artifact: 'metadata',
      source: 'openspec/changes/demo/.openspec.yaml',
    });
  } else {
    await fs.mkdir(path.join(projectDir, 'openspec', 'changes', 'demo'), {
      recursive: true,
    });
    await fs.writeFile(path.join(projectDir, 'openspec', 'changes', 'demo', '.openspec.yaml'), 'schema: spec-driven\n');
  }
  return projectDir;
}

beforeAll(async () => {
  running = await startStubBoard('sagecool');
});

afterAll(async () => {
  await running.close();
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('openspec status --json planning home kind', { timeout: 60_000 }, () => {
  it('reports kind board for a repository that declares a board', async () => {
    const cwd = await scaffoldProject(true);
    const result = await runCLI(['status', '--change', 'demo', '--json'], {
      cwd,
      env: { AGORA_TOKEN: 'stub-token' },
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.planningHome.kind).toBe('board');
    expect(payload.planningHome.root).toBe(await fs.realpath(cwd));
  });

  it('reports kind repo for a repository without a board', async () => {
    const cwd = await scaffoldProject(false);
    const result = await runCLI(['status', '--change', 'demo', '--json'], {
      cwd,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.planningHome.kind).toBe('repo');
  });
});
