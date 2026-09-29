import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileChangeStore } from '../../../src/core/change-store/index.js';

describe('FileChangeStore', () => {
  let root: string;
  let store: FileChangeStore;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-file-change-store-')));
    const changeDir = path.join(root, 'openspec', 'changes', 'add-search');
    fs.mkdirSync(path.join(changeDir, 'specs', 'search'), { recursive: true });
    fs.mkdirSync(path.join(changeDir, 'specs', 'shortlists'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, 'openspec', 'changes', 'archive', '2026-01-01-old'), { recursive: true });
    fs.mkdirSync(path.join(root, 'openspec', 'changes', '.hidden'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, 'openspec', 'specs', 'search'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, 'openspec', 'specs', 'search', 'spec.md'), '# search\n');
    fs.writeFileSync(path.join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-09-01\n');
    fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Proposal\n');
    fs.writeFileSync(
      path.join(changeDir, 'tasks.md'),
      ['## 1. Group', '', '- [x] 1.1 Done already', '- [ ] 1.2 Still open', '- [ ] 1.3 Also open', ''].join('\n')
    );
    fs.writeFileSync(path.join(changeDir, 'specs', 'search', 'spec.md'), '## MODIFIED Requirements\n');
    fs.writeFileSync(path.join(changeDir, 'specs', 'shortlists', 'spec.md'), '## ADDED Requirements\n');
    store = new FileChangeStore({ projectRoot: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('derives the upstream directories from the project root', () => {
    expect(store.kind).toBe('file');
    expect(store.changesDir).toBe(path.join(root, 'openspec', 'changes'));
    expect(store.changeDir('add-search')).toBe(path.join(root, 'openspec', 'changes', 'add-search'));
  });

  it('lists active changes, excluding the archive and hidden directories', async () => {
    expect(await store.listChanges()).toEqual(['add-search']);
    expect(await store.changeExists('add-search')).toBe(true);
    expect(await store.changeExists('missing')).toBe(false);
    expect(
      await new FileChangeStore({
        projectRoot: path.join(root, 'nowhere'),
      }).listChanges()
    ).toEqual([]);
  });

  it('reads and writes metadata and reads markers fail-closed', async () => {
    expect(await store.readMetadata('add-search')).toEqual({
      schema: 'spec-driven',
      created: '2026-09-01',
    });
    await store.writeMetadata('add-search', {
      schema: 'spec-driven',
      created: '2026-09-01',
      skip_specs: true,
    });
    expect(await store.readMarker('add-search', 'skip_specs')).toEqual({
      declared: true,
    });
    expect(await store.readMarker('add-search', 'retire_capabilities')).toEqual({ declared: false });
    expect(await store.readMetadata('missing')).toBeNull();
  });

  it('resolves artefact outputs through the artifact-graph resolver', async () => {
    expect(await store.resolveOutputs('add-search', 'proposal.md')).toEqual([
      path.join(root, 'openspec', 'changes', 'add-search', 'proposal.md'),
    ]);
    expect(await store.outputExists('add-search', 'proposal.md')).toBe(true);
    expect(await store.outputExists('add-search', 'design.md')).toBe(false);
    expect(await store.resolveOutputs('add-search', 'specs/**/spec.md')).toEqual([
      path.join(root, 'openspec', 'changes', 'add-search', 'specs', 'search', 'spec.md'),
      path.join(root, 'openspec', 'changes', 'add-search', 'specs', 'shortlists', 'spec.md'),
    ]);
  });

  it('reads and writes artefacts inside the change directory only', async () => {
    expect(await store.readArtifact('add-search', 'proposal.md')).toBe('# Proposal\n');
    expect(await store.readArtifact('add-search', 'design.md')).toBeNull();
    const written = await store.writeArtifact('add-search', 'design.md', '# Design\n');
    expect(written).toEqual({
      id: path.join(root, 'openspec', 'changes', 'add-search', 'design.md'),
    });
    expect(fs.readFileSync(written.id, 'utf-8')).toBe('# Design\n');
    await store.writeArtifact('add-search', 'specs/new-cap/spec.md', '## ADDED Requirements\n');
    expect(fs.existsSync(path.join(root, 'openspec', 'changes', 'add-search', 'specs', 'new-cap', 'spec.md'))).toBe(
      true
    );
    await expect(store.readArtifact('add-search', '../other/proposal.md')).rejects.toThrow();
  });

  it('lists delta specs and the ones with no main spec yet', async () => {
    expect((await store.listDeltaSpecs('add-search')).map((delta) => delta.id)).toEqual(['search', 'shortlists']);
    expect((await store.listUnreadDeltas('add-search')).map((delta) => delta.id)).toEqual(['shortlists']);
    expect(await store.hasAnyContent('add-search')).toBe(true);
    expect(await store.hasAnyContent('missing')).toBe(false);
  });

  it('lists tasks by ordinal and completes one by ticking its line', async () => {
    expect(await store.listTasks('add-search')).toEqual([
      { ordinal: 1, id: '1', description: '1.1 Done already', done: true },
      { ordinal: 2, id: '2', description: '1.2 Still open', done: false },
      { ordinal: 3, id: '3', description: '1.3 Also open', done: false },
    ]);
    expect(await store.takeTask('add-search', 2)).toEqual({
      ordinal: 2,
      id: '2',
      description: '1.2 Still open',
      done: false,
    });
    expect(await store.completeTask('add-search', 2)).toEqual({
      ordinal: 2,
      id: '2',
      description: '1.2 Still open',
      done: true,
    });
    expect(fs.readFileSync(path.join(root, 'openspec', 'changes', 'add-search', 'tasks.md'), 'utf-8')).toBe(
      ['## 1. Group', '', '- [x] 1.1 Done already', '- [x] 1.2 Still open', '- [ ] 1.3 Also open', ''].join('\n')
    );
    expect(await store.releaseTask('add-search', 3)).toMatchObject({
      ordinal: 3,
      done: false,
    });
    await expect(store.completeTask('add-search', 9)).rejects.toThrow("Task 9 not found in change 'add-search'");
    expect(await store.listTasks('missing')).toEqual([]);
  });

  it('reports when a change last changed', async () => {
    const modified = await store.changeLastModified('add-search');
    expect(modified).toBeInstanceOf(Date);
    expect(await store.changeLastModified('missing')).toBeNull();
  });

  it('creates a change under its changes directory', async () => {
    const result = await store.createChange('brand-new');
    expect(result.changeDir).toBe(path.join(root, 'openspec', 'changes', 'brand-new'));
    expect(await store.readMetadata('brand-new')).toMatchObject({
      schema: 'spec-driven',
    });
    expect(await store.listChanges()).toEqual(['add-search', 'brand-new']);
  });
});
