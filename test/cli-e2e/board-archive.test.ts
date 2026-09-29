import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'node:child_process';
import { runCLI } from '../helpers/run-cli.js';
import { isolatedGitEnv } from '../helpers/store-git.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;
const env = { AGORA_TOKEN: 'stub-token' };

const DELTA = [
  '## ADDED Requirements',
  '',
  '### Requirement: Search by name',
  '',
  'The system SHALL find a class by its name.',
  '',
  '#### Scenario: Exact name',
  '',
  '- **WHEN** a learner types the full name',
  '- **THEN** the class is listed first',
  '',
].join('\n');

const TASKS = ['## 1. Group', '', '- [ ] 1.1 First', '- [ ] 1.2 Second', ''].join('\n');

/** A git working tree with a board-backed OpenSpec root and one planned change on the stub board. */
async function scaffoldRepository(): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-board-archive-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: running.url }));
  const gitEnv = isolatedGitEnv(base);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir, env: gitEnv });
  execFileSync('git', ['add', '-A'], { cwd: projectDir, env: gitEnv });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-m', 'root'], {
    cwd: projectDir,
    env: gitEnv,
  });

  await fs.writeFile(path.join(projectDir, 'proposal.in.md'), '# Search\n\n## Why\n\nFinding classes.\n');
  await fs.writeFile(path.join(projectDir, 'delta.in.md'), DELTA);
  await fs.writeFile(path.join(projectDir, 'tasks.in.md'), TASKS);
  for (const args of [
    ['new', 'change', 'add-search', '--json'],
    ['change', 'write', 'add-search', 'proposal', '--file', 'proposal.in.md'],
    ['change', 'write', 'add-search', 'specs', '--capability', 'search', '--file', 'delta.in.md'],
    ['change', 'write', 'add-search', 'tasks', '--file', 'tasks.in.md'],
  ]) {
    const result = await runCLI(args, { cwd: projectDir, env });
    expect(result.exitCode, `${args.join(' ')}: ${result.stderr}`).toBe(0);
  }
  for (const file of ['proposal.in.md', 'delta.in.md', 'tasks.in.md']) await fs.rm(path.join(projectDir, file));
  return projectDir;
}

beforeAll(async () => {
  running = await startStubBoard('sagecool');
});

afterAll(async () => {
  await running.close();
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('archive of a board change', () => {
  it('refuses while a task tuple is still open, unless --yes', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldRepository();
    expect((await runCLI(['task', 'complete', 'add-search', '1'], { cwd, env })).exitCode).toBe(0);

    const refused = await runCLI(['archive', 'add-search', '--json'], {
      cwd,
      env,
    });
    expect(refused.exitCode).toBe(1);
    const payload = JSON.parse(refused.stdout);
    expect(payload.archive).toBeNull();
    expect(payload.status[0]).toMatchObject({
      code: 'archive_tasks_incomplete',
      message: "1 incomplete task(s) found for change 'add-search'.",
    });
    expect(running.stub.live().some((tuple) => tuple.subjects.includes('change:add-search'))).toBe(true);
    await expect(fs.access(path.join(cwd, 'openspec', 'specs', 'search'))).rejects.toThrow();

    const forced = await runCLI(['archive', 'add-search', '--json', '--yes'], {
      cwd,
      env,
    });
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(forced.stdout).archive.specsUpdated).toBe(true);
  });

  it('merges the delta specs into the working tree, retires every tuple, and creates no archive directory', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldRepository();
    expect((await runCLI(['task', 'complete', 'add-search', '1'], { cwd, env })).exitCode).toBe(0);
    expect((await runCLI(['task', 'complete', 'add-search', '2'], { cwd, env })).exitCode).toBe(0);
    const liveBefore = running.stub.live().filter((tuple) => tuple.subjects.includes('change:add-search'));
    expect(liveBefore.length).toBeGreaterThan(0);

    const result = await runCLI(['archive', 'add-search', '--json'], {
      cwd,
      env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.archive).toMatchObject({
      change: 'add-search',
      archivedAs: 'change:add-search',
      specsUpdated: true,
      totals: { added: 1, modified: 0, removed: 0, renamed: 0 },
      archivedTuples: liveBefore.length,
    });

    // The merged spec is in the working tree, uncommitted, for the caller to commit.
    const merged = await fs.readFile(path.join(cwd, 'openspec', 'specs', 'search', 'spec.md'), 'utf-8');
    expect(merged).toContain('### Requirement: Search by name');
    expect(merged).toContain('#### Scenario: Exact name');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      env: isolatedGitEnv(path.dirname(cwd)),
    })
      .toString()
      .trim();
    expect(status).toContain('openspec/specs/search/spec.md');
    await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();

    // A default search finds nothing of the change; its tuples are retired and readable by id.
    expect(running.stub.live().filter((tuple) => tuple.subjects.includes('change:add-search'))).toEqual([]);
    for (const tuple of liveBefore) {
      const now = running.stub.tuples.get(tuple.id)!;
      expect(now.state).toBe('retired');
      expect(now.archived).toBe(true);
    }
    expect((await runCLI(['list', '--json'], { cwd, env })).stdout).toContain('"changes": []');
  });
});
