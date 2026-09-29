/**
 * The change store exposed to skills and people: `openspec change read` and
 * `openspec change write` move one artefact's content in and out of whatever
 * store the root uses, and `openspec task take|complete|release` wrap the
 * task verbs by ordinal. One code path for the file store and the board, so a
 * skill template never needs to know which it is talking to.
 */

import { promises as fs } from 'fs';
import { loadChangeContextFor } from '../core/change-store/context.js';
import type { ChangeStore, StoredTask } from '../core/change-store/types.js';
import {
  resolveRootForCommand,
  toRootOutput,
  type RootOutput,
  type StoreSelectorOptions,
} from '../core/root-selection.js';
import { printJson } from './workflow/shared.js';

export interface ArtifactSelectionOptions extends StoreSelectorOptions {
  capability?: string;
  json?: boolean;
}

export interface ChangeWriteOptions extends ArtifactSelectionOptions {
  base?: string;
  force?: boolean;
  file?: string;
}

export type TaskVerb = 'take' | 'complete' | 'release';

/**
 * The path an artefact name means for a change: a schema artefact id resolves
 * through its `generates` (a glob needs `--capability` to pick one file),
 * `metadata` is `.openspec.yaml`, and anything with a slash or an extension is
 * taken as the path itself.
 */
export async function artifactPathFor(
  store: ChangeStore,
  changeName: string,
  artifact: string,
  capability?: string
): Promise<string> {
  if (artifact === 'metadata' || artifact === '.openspec.yaml') return '.openspec.yaml';
  if (artifact.includes('/') || artifact.includes('.')) return artifact;

  const context = await loadChangeContextFor(store, changeName);
  const known = context.graph.getAllArtifacts().find((candidate) => candidate.id === artifact);
  if (!known) {
    const ids = context.graph.getAllArtifacts().map((candidate) => candidate.id);
    throw new Error(
      `Unknown artifact '${artifact}' for change '${changeName}' (schema ${context.schemaName}). ` +
        `Artifacts: ${ids.join(', ')}; or pass a path such as specs/<capability>/spec.md.`
    );
  }
  if (!/[*?]/.test(known.generates)) return known.generates;
  if (!capability) {
    throw new Error(
      `Artifact '${artifact}' generates ${known.generates}, one file per capability. Pass --capability <name>.`
    );
  }
  // `specs/**/*.md` with capability `search` is `specs/search/spec.md`: the
  // capability fills the directory, and the one file a capability holds is spec.md.
  return known.generates.replace(/\*\*/g, capability).replace(/\*/g, 'spec').replace(/\/\/+/g, '/');
}

async function readInput(file: string | undefined): Promise<string> {
  if (!file) {
    throw new Error('Pass --file <path> with the content to write, or --file - to read it from stdin.');
  }
  if (file === '-') {
    let content = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) content += chunk;
    return content;
  }
  return fs.readFile(file, 'utf-8');
}

function describe(artifact: string, capability: string | undefined): string {
  return capability ? `${artifact} ${capability}` : artifact;
}

export async function changeReadCommand(
  changeName: string,
  artifact: string,
  options: ArtifactSelectionOptions
): Promise<void> {
  const root = await resolveRootForCommand(options, {
    json: options.json,
    failurePayload: { change: changeName },
  });
  if (!root) return;
  const artifactPath = await artifactPathFor(root.store, changeName, artifact, options.capability);
  const version = await root.store.readArtifactVersion(changeName, artifactPath);
  if (!version) {
    throw new Error(`Change '${changeName}' has no ${describe(artifact, options.capability)} yet (${artifactPath}).`);
  }
  if (options.json) {
    printJson({
      change: changeName,
      artifact,
      ...(options.capability ? { capability: options.capability } : {}),
      path: artifactPath,
      id: version.id,
      content: version.content,
      root: toRootOutput(root),
    });
    return;
  }
  process.stdout.write(version.content);
}

export async function changeWriteCommand(
  changeName: string,
  artifact: string,
  options: ChangeWriteOptions
): Promise<void> {
  const root = await resolveRootForCommand(options, {
    json: options.json,
    failurePayload: { change: changeName },
  });
  if (!root) return;
  const artifactPath = await artifactPathFor(root.store, changeName, artifact, options.capability);
  const content = await readInput(options.file);
  const written = await root.store.writeArtifact(changeName, artifactPath, content, {
    ...(options.base !== undefined ? { base: options.base } : {}),
    ...(options.force ? { force: true } : {}),
  });
  const payload = {
    change: changeName,
    artifact,
    ...(options.capability ? { capability: options.capability } : {}),
    path: artifactPath,
    id: written.id,
    root: toRootOutput(root) as RootOutput,
  };
  if (options.json) {
    printJson(payload);
    return;
  }
  console.log(`Wrote ${describe(artifact, options.capability)} of change '${changeName}' (${written.id})`);
}

const TASK_PAST_TENSE: Record<TaskVerb, string> = {
  take: 'Took',
  complete: 'Completed',
  release: 'Released',
};

export async function taskCommand(
  verb: TaskVerb,
  changeName: string,
  ordinalText: string,
  options: StoreSelectorOptions & { json?: boolean }
): Promise<void> {
  const ordinal = Number(ordinalText);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`Task ordinal must be a positive integer, got '${ordinalText}'.`);
  }
  const root = await resolveRootForCommand(options, {
    json: options.json,
    failurePayload: { change: changeName },
  });
  if (!root) return;
  if (!(await root.store.changeExists(changeName))) {
    throw new Error(`Change '${changeName}' not found.`);
  }
  let task: StoredTask;
  if (verb === 'take') task = await root.store.takeTask(changeName, ordinal);
  else if (verb === 'complete') task = await root.store.completeTask(changeName, ordinal);
  else task = await root.store.releaseTask(changeName, ordinal);

  if (options.json) {
    printJson({ change: changeName, task, root: toRootOutput(root) });
    return;
  }
  console.log(`${TASK_PAST_TENSE[verb]} task ${task.ordinal} of change '${changeName}': ${task.description}`);
}
