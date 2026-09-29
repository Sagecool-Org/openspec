import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRetireCapabilitiesMarker, readSkipSpecsMarker } from '../../src/utils/change-metadata.js';

/**
 * The marker readers resolve a change's schema against the OpenSpec root. A
 * change that does not sit exactly at <root>/openspec/changes/<name>, such as
 * an archived one, must be read with the resolved root passed in; deriving the
 * root from the change directory lands one level too deep and reports the
 * project-local schema as unknown.
 */
describe('marker readers with a resolved root', () => {
  let root: string;
  let nestedChangeDir: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-metadata-root-')));
    const schemaDir = path.join(root, 'openspec', 'schemas', 'project-local');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.writeFileSync(
      path.join(schemaDir, 'schema.yaml'),
      [
        'name: project-local',
        'version: 1',
        'artifacts:',
        '  - id: proposal',
        '    generates: proposal.md',
        '    description: Proposal',
        '    template: proposal.md',
        '    requires: []',
        '',
      ].join('\n')
    );
    nestedChangeDir = path.join(root, 'openspec', 'changes', 'archive', '2026-01-01-nested');
    fs.mkdirSync(nestedChangeDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedChangeDir, '.openspec.yaml'),
      'schema: project-local\nskip_specs: true\nretire_capabilities: true\n'
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('honours the markers of a nested change when given the resolved root', () => {
    expect(readSkipSpecsMarker(nestedChangeDir, root)).toEqual({
      declared: true,
    });
    expect(readRetireCapabilitiesMarker(nestedChangeDir, root)).toEqual({
      declared: true,
    });
  });

  it('cannot resolve the schema of a nested change from its path alone', () => {
    expect(readSkipSpecsMarker(nestedChangeDir)).toEqual({
      declared: false,
      invalidReason: "schema: unknown schema 'project-local'",
    });
  });

  it('honours the markers of an active change either way', () => {
    const activeChangeDir = path.join(root, 'openspec', 'changes', 'active');
    fs.mkdirSync(activeChangeDir, { recursive: true });
    fs.writeFileSync(path.join(activeChangeDir, '.openspec.yaml'), 'schema: project-local\nskip_specs: true\n');
    expect(readSkipSpecsMarker(activeChangeDir)).toEqual({ declared: true });
    expect(readSkipSpecsMarker(activeChangeDir, root)).toEqual({
      declared: true,
    });
  });
});
