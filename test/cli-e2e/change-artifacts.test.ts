import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;
const boardEnv = { AGORA_TOKEN: 'stub-token' };

const TASKS = ['## 1. Group', '', '- [ ] 1.1 First', '- [ ] 1.2 Second', '- [ ] 1.3 Third', ''].join('\n');

async function scaffoldProject(withBoard: boolean): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-change-artifacts-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(projectDir, 'proposal-input.md'), '# Demo\n\n## Why\n\nBecause.\n');
  await fs.writeFile(path.join(projectDir, 'tasks-input.md'), TASKS);
  await fs.writeFile(
    path.join(projectDir, 'spec-input.md'),
    '## ADDED Requirements\n\n### Requirement: X\n\nThe system SHALL x.\n\n#### Scenario: Y\n\n- **WHEN** a\n- **THEN** b\n'
  );
  if (withBoard) {
    await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url: running.url }));
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

for (const store of ['file', 'board'] as const) {
  describe(`change read/write and task verbs on the ${store} store`, () => {
    const env = store === 'board' ? boardEnv : {};

    it('writes, reads and revises artifacts, and takes, completes and releases tasks', async () => {
      running.stub.tuples.clear();
      const cwd = await scaffoldProject(store === 'board');
      expect((await runCLI(['new', 'change', 'demo', '--json'], { cwd, env })).exitCode).toBe(0);

      // Write the proposal from a file.
      const wrote = await runCLI(['change', 'write', 'demo', 'proposal', '--file', 'proposal-input.md', '--json'], {
        cwd,
        env,
      });
      expect(wrote.stderr).toBe('');
      expect(wrote.exitCode).toBe(0);
      const written = JSON.parse(wrote.stdout);
      expect(written).toMatchObject({
        change: 'demo',
        artifact: 'proposal',
        path: 'proposal.md',
      });
      if (store === 'board') expect(written.id).toMatch(/-artefact-demo-proposal$/);

      // Read it back, with the version id.
      const read = await runCLI(['change', 'read', 'demo', 'proposal', '--json'], { cwd, env });
      expect(read.stderr).toBe('');
      expect(read.exitCode).toBe(0);
      const version = JSON.parse(read.stdout);
      expect(version.content).toBe('# Demo\n\n## Why\n\nBecause.\n');
      expect(version.id).toBe(written.id);
      const raw = await runCLI(['change', 'read', 'demo', 'proposal'], {
        cwd,
        env,
      });
      expect(raw.stdout).toBe('# Demo\n\n## Why\n\nBecause.\n');

      // A per-capability artifact needs --capability.
      const noCapability = await runCLI(['change', 'write', 'demo', 'specs', '--file', 'spec-input.md'], { cwd, env });
      expect(noCapability.exitCode).toBe(1);
      expect(noCapability.stderr).toMatch(/Pass --capability/);
      const spec = await runCLI(
        ['change', 'write', 'demo', 'specs', '--capability', 'search', '--file', 'spec-input.md', '--json'],
        { cwd, env }
      );
      expect(spec.exitCode).toBe(0);
      expect(JSON.parse(spec.stdout).path).toBe('specs/search/spec.md');
      const specRead = await runCLI(['change', 'read', 'demo', 'specs', '--capability', 'search'], { cwd, env });
      expect(specRead.stdout).toMatch(/^## ADDED Requirements/);

      // Tasks: write, take, complete, release; the rendered tasks show the state.
      expect(
        (await runCLI(['change', 'write', 'demo', 'tasks', '--file', 'tasks-input.md'], { cwd, env })).exitCode
      ).toBe(0);
      const took = await runCLI(['task', 'take', 'demo', '2', '--json'], {
        cwd,
        env,
      });
      expect(took.exitCode).toBe(0);
      expect(JSON.parse(took.stdout).task).toMatchObject({
        ordinal: 2,
        description: '1.2 Second',
        done: false,
      });
      const completed = await runCLI(['task', 'complete', 'demo', '2'], {
        cwd,
        env,
      });
      expect(completed.exitCode).toBe(0);
      expect(completed.stdout.trim()).toBe("Completed task 2 of change 'demo': 1.2 Second");
      const released = await runCLI(['task', 'release', 'demo', '3', '--json'], { cwd, env });
      expect(released.exitCode).toBe(0);
      expect(JSON.parse(released.stdout).task).toMatchObject({
        ordinal: 3,
        done: false,
      });
      const tasks = await runCLI(['change', 'read', 'demo', 'tasks'], {
        cwd,
        env,
      });
      expect(tasks.stdout).toBe(TASKS.replace('- [ ] 1.2 Second', '- [x] 1.2 Second'));
      const missing = await runCLI(['task', 'complete', 'demo', '9'], {
        cwd,
        env,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toMatch(/Task 9 not found/);

      // A revision names the version it read; stdin works too.
      const revised = await runCLI(
        ['change', 'write', 'demo', 'proposal', '--base', version.id, '--file', '-', '--json'],
        {
          cwd,
          env,
          input: '# Demo v2\n',
        }
      );
      expect(revised.exitCode).toBe(0);
      expect((await runCLI(['change', 'read', 'demo', 'proposal'], { cwd, env })).stdout).toBe('# Demo v2\n');

      if (store === 'board') {
        // The old version is stale now; --force overrides.
        const stale = await runCLI(
          ['change', 'write', 'demo', 'proposal', '--base', version.id, '--file', 'proposal-input.md'],
          { cwd, env }
        );
        expect(stale.exitCode).toBe(1);
        expect(stale.stderr).toMatch(/has moved on: the live version is/);
        const forced = await runCLI(
          ['change', 'write', 'demo', 'proposal', '--base', version.id, '--force', '--file', 'proposal-input.md'],
          { cwd, env }
        );
        expect(forced.exitCode).toBe(0);
        await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();
      } else {
        expect(await fs.readFile(path.join(cwd, 'openspec', 'changes', 'demo', 'proposal.md'), 'utf-8')).toBe(
          '# Demo v2\n'
        );
        expect(await fs.readFile(path.join(cwd, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf-8')).toBe(
          TASKS.replace('- [ ] 1.2 Second', '- [x] 1.2 Second')
        );
      }
    });

    it('names the artifacts of the schema when asked for an unknown one', async () => {
      running.stub.tuples.clear();
      const cwd = await scaffoldProject(store === 'board');
      expect((await runCLI(['new', 'change', 'demo', '--json'], { cwd, env })).exitCode).toBe(0);
      const result = await runCLI(['change', 'read', 'demo', 'blueprint'], {
        cwd,
        env,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Unknown artifact 'blueprint'.*Artifacts: proposal, specs, design, tasks/);
      const none = await runCLI(['change', 'read', 'demo', 'design'], {
        cwd,
        env,
      });
      expect(none.exitCode).toBe(1);
      expect(none.stderr).toMatch(/has no design yet \(design\.md\)/);
    });
  });
}
