import path from 'node:path';
import type { BoardChangeStore } from './board-change-store.js';
import type { FileChangeStore } from './file-change-store.js';

export interface ImportedTuple {
  /** The artefact's path under the change, as it was on disk. */
  path: string;
  id: string;
}

export interface ImportResult {
  change: string;
  artefacts: ImportedTuple[];
  tasks: Array<{ ordinal: number; id: string; done: boolean }>;
}

/**
 * Posts a change directory to the board under the conventions: metadata
 * first, then every other artefact, the tasks artefact last so its checklist
 * becomes task tuples with checked items completed. The directory is left for
 * the caller to remove (design D8); the ids are what the caller records.
 */
export async function importChangeToBoard(
  board: BoardChangeStore,
  source: FileChangeStore,
  changeName: string
): Promise<ImportResult> {
  const snapshot = await source.snapshot(changeName);
  if (!snapshot.exists) {
    throw new Error(`Change '${changeName}' not found at ${source.changeDir(changeName)}`);
  }
  if (!snapshot.metadata) {
    throw new Error(`Change '${changeName}' has no .openspec.yaml to import; a board change starts from its metadata.`);
  }
  if (await board.changeExists(changeName)) {
    throw new Error(
      `Change '${changeName}' is already on the board at ${board.board.url}; export or archive it first.`
    );
  }

  const artefacts: ImportedTuple[] = [];
  await board.writeMetadata(changeName, snapshot.metadata);
  const metadata = await board.readArtifactVersion(changeName, '.openspec.yaml');
  if (metadata) artefacts.push({ path: '.openspec.yaml', id: metadata.id });

  const others = snapshot.outputs.filter((output) => output !== '.openspec.yaml' && output !== 'tasks.md');
  const rest = snapshot.outputs.includes('tasks.md') ? [...others, 'tasks.md'] : others;
  for (const relative of rest) {
    const content = await source.readArtifact(changeName, relative);
    if (content === null) continue;
    const written = await board.writeArtifact(changeName, relative, content, {
      ...(relative === 'tasks.md' ? { importCheckboxes: true } : {}),
    });
    artefacts.push({ path: relative, id: written.id });
  }

  const tasks = (await board.listTasks(changeName)).map((task) => ({
    ordinal: task.ordinal,
    id: task.id,
    done: task.done,
  }));
  return { change: changeName, artefacts, tasks };
}

export interface ExportResult {
  change: string;
  directory: string;
  files: string[];
}

/**
 * Writes the current version of every artefact back to the upstream layout,
 * each task's checkbox rendered from its tuple, so a repository can return to
 * the file store without loss. This is the rollback of an import.
 */
export async function exportChangeFromBoard(
  board: BoardChangeStore,
  changeName: string,
  targetDir = path.join(board.changesDir, changeName)
): Promise<ExportResult> {
  await board.exportChange(changeName, targetDir);
  const files = (await board.snapshot(changeName)).outputs;
  return { change: changeName, directory: targetDir, files };
}

export interface RefreshedTuple {
  kind: 'artefact' | 'task';
  path: string;
  previousId: string;
  id: string;
  expired: string;
}

export interface RefreshResult {
  change: string;
  threshold: string;
  refreshed: RefreshedTuple[];
}

export const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-posts every live tuple of the change that expires within the window as a
 * superseding copy (design D6): an artefact as a new version with the same
 * content, a task as a new tuple inheriting its state, through the tasks
 * write so the tasks artefact's `task_ids` follow. Tuples with time left are
 * untouched, so a refresh a day after another writes nothing.
 */
export async function refreshChange(
  board: BoardChangeStore,
  changeName: string,
  options: { now?: Date; windowMs?: number } = {}
): Promise<RefreshResult> {
  const now = options.now ?? new Date();
  const threshold = new Date(now.getTime() + (options.windowMs ?? REFRESH_WINDOW_MS)).toISOString();
  const expiring = (expires: unknown): boolean => typeof expires === 'string' && expires < threshold;

  const refreshed: RefreshedTuple[] = [];
  const artefacts = await board.allLiveArtefacts(changeName);
  if (artefacts.length === 0) {
    throw new Error(`Change '${changeName}' is not on the board at ${board.board.url}`);
  }

  let tasksArtefact: (typeof artefacts)[number] | undefined;
  for (const tuple of artefacts) {
    const relative = board.relativePathOf(changeName, tuple);
    if (!relative) continue;
    if (tuple.map?.artifact === 'tasks') {
      tasksArtefact = tuple;
      continue;
    }
    if (!expiring(tuple.expires)) continue;
    const version = await board.readArtifactVersion(changeName, relative);
    if (!version) continue;
    const written = await board.writeArtifact(changeName, relative, version.content, { base: version.id });
    refreshed.push({
      kind: 'artefact',
      path: relative,
      previousId: tuple.id,
      id: written.id,
      expired: String(tuple.expires),
    });
  }

  if (tasksArtefact) {
    const relative = board.relativePathOf(changeName, tasksArtefact) ?? 'tasks.md';
    const tasksBefore = await board.listTasks(changeName);
    const expiringTasks = tasksBefore.filter((task) => expiring(task.expires));
    if (expiring(tasksArtefact.expires) || expiringTasks.length > 0) {
      const stored = await board.readArtifactVersion(changeName, relative);
      if (stored) {
        const written = await board.writeArtifact(changeName, relative, stored.content, {
          base: stored.id,
          refreshBefore: threshold,
        });
        if (expiring(tasksArtefact.expires)) {
          refreshed.push({
            kind: 'artefact',
            path: relative,
            previousId: tasksArtefact.id,
            id: written.id,
            expired: String(tasksArtefact.expires),
          });
        }
        const tasksAfter = await board.listTasks(changeName);
        for (const task of expiringTasks) {
          const replacement = tasksAfter.find((candidate) => candidate.ordinal === task.ordinal);
          if (replacement && replacement.id !== task.id) {
            refreshed.push({
              kind: 'task',
              path: `${relative}#${task.ordinal}`,
              previousId: task.id,
              id: replacement.id,
              expired: String(task.expires),
            });
          }
        }
      }
    }
  }

  return { change: changeName, threshold, refreshed };
}
