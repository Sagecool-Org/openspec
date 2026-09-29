import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';
import { snapshotDirectory } from '../helpers/fs-snapshot.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;
const env = { AGORA_TOKEN: 'stub-token' };

const FIXTURE: Record<string, string> = {
  '.openspec.yaml': 'schema: spec-driven\ncreated: 2026-09-01\n',
  'proposal.md': '# Consolidate search UI\n\n## Why\n\nOne composition.\n',
  'design.md': '# Design\n\nOne container.\n',
  'specs/search-ui/spec.md': [
    '## MODIFIED Requirements',
    '',
    '### Requirement: One results list',
    '',
    'The system SHALL render one list.',
    '',
    '#### Scenario: Default',
    '',
    '- **WHEN** the page loads',
    '- **THEN** one list is shown',
    '',
  ].join('\n'),
  'tasks.md': [
    '## 1. Compose',
    '',
    '- [x] 1.1 Extract the container',
    '- [ ] 1.2 Move the facets',
    '- [ ] 1.3 Move the results',
    '- [ ] 1.4 Move the shortlist',
    '',
    '## 2. Verify',
    '',
    '- [ ] 2.1 Browser spec',
    '- [ ] 2.2 Feature spec',
    '- [ ] 2.3 Visual QA',
    '',
  ].join('\n'),
};

async function scaffoldProject(): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-board-migration-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: running.url }));
  const changeDir = path.join(projectDir, 'openspec', 'changes', 'consolidate-search-ui-composition');
  for (const [relative, content] of Object.entries(FIXTURE)) {
    await fs.mkdir(path.dirname(path.join(changeDir, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(changeDir, relative), content);
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

describe('board import and export', () => {
  it('imports a directory as tuples with checked items completed, and exports it back byte for byte', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldProject();
    const changeDir = path.join(cwd, 'openspec', 'changes', 'consolidate-search-ui-composition');
    const before = snapshotDirectory(changeDir);

    const imported = await runCLI(['board', 'import', 'consolidate-search-ui-composition', '--json'], { cwd, env });
    expect(imported.exitCode, imported.stderr).toBe(0);
    const result = JSON.parse(imported.stdout);
    expect(result.artefacts.map((artefact: { path: string }) => artefact.path)).toEqual([
      '.openspec.yaml',
      'design.md',
      'proposal.md',
      'specs/search-ui/spec.md',
      'tasks.md',
    ]);
    for (const artefact of result.artefacts) expect(artefact.id).toMatch(/^[a-z]{5}-[a-z]{5}-artefact-/);
    expect(result.tasks).toHaveLength(7);
    expect(result.tasks.map((task: { ordinal: number; done: boolean }) => [task.ordinal, task.done])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
      [6, false],
      [7, false],
    ]);
    const liveArtefacts = running.stub.live().filter((tuple) => tuple.kind === 'artefact');
    expect(liveArtefacts.map((tuple) => tuple.map.artifact).sort()).toEqual([
      'design',
      'metadata',
      'proposal',
      'spec',
      'tasks',
    ]);
    expect(liveArtefacts.find((tuple) => tuple.map.artifact === 'spec')?.map.capability).toBe('search-ui');
    expect(running.stub.tuples.get(result.tasks[0].id)?.state).toBe('retired');
    // The directory is left for the caller to remove.
    expect(snapshotDirectory(changeDir)).toEqual(before);

    // Rolling back: export writes the same directory, checkbox states preserved.
    await fs.rm(changeDir, { recursive: true, force: true });
    const exported = await runCLI(['board', 'export', 'consolidate-search-ui-composition', '--json'], { cwd, env });
    expect(exported.exitCode, exported.stderr).toBe(0);
    expect(await fs.realpath(JSON.parse(exported.stdout).directory)).toBe(await fs.realpath(changeDir));
    expect(snapshotDirectory(changeDir)).toEqual(before);

    // The upstream file reading of the exported directory agrees on progress.
    const listed = await runCLI(['list', '--json'], { cwd, env });
    expect(JSON.parse(listed.stdout).changes).toEqual([
      expect.objectContaining({
        name: 'consolidate-search-ui-composition',
        completedTasks: 1,
        totalTasks: 7,
      }),
    ]);
  });

  it('refuses to import a change that is already on the board, and needs a board to run', async () => {
    running.stub.tuples.clear();
    const cwd = await scaffoldProject();
    expect(
      (
        await runCLI(['board', 'import', 'consolidate-search-ui-composition'], {
          cwd,
          env,
        })
      ).exitCode
    ).toBe(0);
    const again = await runCLI(['board', 'import', 'consolidate-search-ui-composition'], { cwd, env });
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toMatch(/already on the board/);

    await fs.rm(path.join(cwd, '.agora.json'));
    const noBoard = await runCLI(['board', 'export', 'consolidate-search-ui-composition'], { cwd, env });
    expect(noBoard.exitCode).toBe(1);
    expect(noBoard.stderr).toMatch(/declares no board/);
  });
});
