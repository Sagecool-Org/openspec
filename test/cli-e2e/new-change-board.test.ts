import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../helpers/run-cli.js';
import { startStubBoard, type RunningStubBoard } from '../helpers/stub-board.js';

const tempRoots: string[] = [];
let running: RunningStubBoard;

async function scaffoldProject(withBoard: boolean): Promise<string> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'openspec-new-change-board-'));
  tempRoots.push(base);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(path.join(projectDir, 'openspec', 'specs'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectDir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
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

describe('openspec new change on a board-backed repository', { timeout: 60_000 }, () => {
  it('posts a metadata tuple for change:<name> and creates no directory', async () => {
    const cwd = await scaffoldProject(true);
    const result = await runCLI(['new', 'change', 'demo', '--json'], {
      cwd,
      env: { AGORA_TOKEN: 'stub-token' },
    });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.change).toMatchObject({ id: 'demo', schema: 'spec-driven' });

    await expect(fs.access(path.join(cwd, 'openspec', 'changes'))).rejects.toThrow();

    const metadata = running.stub
      .live()
      .filter((tuple) => tuple.kind === 'artefact' && tuple.map.artifact === 'metadata');
    expect(metadata).toHaveLength(1);
    expect(metadata[0].subjects).toContain('change:demo');
    expect(metadata[0].map).toMatchObject({
      sdd: 'openspec',
      schema: 'spec-driven',
      source: 'openspec/changes/demo/.openspec.yaml',
    });
    expect(metadata[0].content).toMatch(
      /^demo metadata: schema spec-driven, created \d{4}-\d{2}-\d{2}\.\n\n```yaml\nschema: spec-driven\ncreated: \d{4}-\d{2}-\d{2}\n```$/
    );
    expect(
      running.stub.calls.every((call) => call.verb === 'post' || call.verb === 'supersede' || call.verb === 'search')
    ).toBe(true);
  });

  it('scaffolds the change under openspec/changes/ exactly as upstream without a board', async () => {
    const cwd = await scaffoldProject(false);
    const before = running.stub.calls.length;
    const result = await runCLI(['new', 'change', 'demo', '--json'], {
      cwd,
      env: { AGORA_TOKEN: 'stub-token' },
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.change.path).toBe(path.join(await fs.realpath(cwd), 'openspec', 'changes', 'demo'));
    const metadata = await fs.readFile(path.join(cwd, 'openspec', 'changes', 'demo', '.openspec.yaml'), 'utf-8');
    expect(metadata).toMatch(/^schema: spec-driven\ncreated: \d{4}-\d{2}-\d{2}\n$/);
    expect(running.stub.calls.length).toBe(before);
  });
});
