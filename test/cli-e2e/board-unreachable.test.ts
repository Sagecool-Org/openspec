import { afterAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCLI } from '../helpers/run-cli.js';
import { snapshotDirectory } from '../helpers/fs-snapshot.js';

const tempRoots: string[] = [];
const env = { AGORA_TOKEN: 'stub-token' };

async function closedPort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A repository that declares a board nobody answers, with a change directory
 * left on disk beside it: the temptation every command must refuse.
 */
async function scaffoldProject(url: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-board-unreachable-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(projectDir, '.agora.json'), JSON.stringify({ repo: 'sagecool', url }));
  const stale = path.join(projectDir, 'openspec', 'changes', 'stale');
  await fs.mkdir(stale, { recursive: true });
  await fs.writeFile(path.join(stale, '.openspec.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(path.join(stale, 'proposal.md'), '# Stale\n');
  await fs.writeFile(path.join(projectDir, 'input.md'), '# Input\n');
  return projectDir;
}

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('a declared board that does not answer', () => {
  it('fails every change command naming the board, and neither creates nor reads a file under openspec/changes/', async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}`;
    const cwd = await scaffoldProject(url);
    const changesDir = path.join(cwd, 'openspec', 'changes');
    const before = snapshotDirectory(changesDir);

    const commands: string[][] = [
      ['new', 'change', 'fresh', '--json'],
      ['list', '--json'],
      ['status', '--change', 'stale', '--json'],
      ['status', '--all', '--json'],
      ['instructions', 'design', '--change', 'stale', '--json'],
      ['instructions', 'apply', '--change', 'stale', '--json'],
      ['instructions', 'archive', '--change', 'stale', '--json'],
      ['validate', 'stale', '--json'],
      ['show', 'stale', '--type', 'change'],
      ['change', 'read', 'stale', 'proposal'],
      ['change', 'write', 'stale', 'design', '--file', 'input.md'],
      ['task', 'complete', 'stale', '1'],
      ['archive', 'stale', '--json', '--yes'],
      ['board', 'refresh', 'stale'],
    ];

    for (const args of commands) {
      const result = await runCLI(args, { cwd, env });
      const label = args.join(' ');
      expect(result.exitCode, `${label} exit`).not.toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output, `${label} names the board`).toContain(`board at ${url} unreachable`);
      // The change on disk is never read in the board's place: no command reports it.
      expect(output, `${label} does not read the stale directory`).not.toContain('# Stale');
      expect(output, `${label} does not list the stale change as available`).not.toMatch(/"changes":\s*\[\s*\{/);
    }

    // Nothing was created or changed under openspec/changes/.
    expect(snapshotDirectory(changesDir)).toEqual(before);
    await expect(fs.access(path.join(changesDir, 'fresh'))).rejects.toThrow();
  });
});
