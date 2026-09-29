import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArchiveBlockedError, type ArchiveOptions } from '../archive.js';
import { buildUpdatedSpec, findSpecUpdates } from '../specs-apply.js';
import { Validator } from '../validation/validator.js';
import type { BoardChangeStore } from './board-change-store.js';
import { withChangeOnDisk } from './context.js';

export interface BoardArchiveResult {
  change: string;
  /** What the change is known as after archive: its subject on the board. */
  archivedAs: string;
  /** Where it lives now: the board, not a directory. */
  path: string;
  specsUpdated: boolean;
  totals?: {
    added: number;
    modified: number;
    removed: number;
    renamed: number;
  };
  warnings?: string[];
  /** How many live tuples of the change were archived. */
  archivedTuples: number;
}

/**
 * Archive for a board change (design D2): validate as upstream does, refuse
 * on open tasks unless `--yes`, merge the live delta specs into
 * `openspec/specs/` in the working tree with the unchanged spec-merge code and
 * leave the files for the caller to commit, then archive every live tuple of
 * the change so it is retired but readable by id. Nothing is written under
 * `openspec/changes/`: no move, no fingerprints, no rollback snapshot, because
 * the board keeps the change and git keeps the specs.
 */
export async function archiveBoardChange(
  store: BoardChangeStore,
  changeName: string,
  options: ArchiveOptions = {}
): Promise<BoardArchiveResult> {
  const specsDir = path.join(store.projectRoot, 'openspec', 'specs');

  if (!(await store.changeExists(changeName))) {
    const available = await store.listChanges();
    throw new ArchiveBlockedError(
      'archive_change_not_found',
      available.length > 0
        ? `Change '${changeName}' not found. Available changes: ${available.join(', ')}`
        : `Change '${changeName}' not found. No active changes exist on the board at ${store.board.url}.`
    );
  }

  const skipValidation = options.validate === false || options.noValidate === true;
  if (skipValidation) {
    if (!options.yes) {
      throw new ArchiveBlockedError(
        'archive_confirmation_required',
        'Skipping validation requires confirmation: rerun with --yes.',
        `openspec archive ${changeName} --no-validate --yes`
      );
    }
  } else if (await store.hasAnyContent(changeName)) {
    const report = await withChangeOnDisk(store, changeName, (onDisk) =>
      new Validator().validateChangeDeltaSpecs(path.join(onDisk.changesDir, changeName), {
        mainSpecsDir: specsDir,
        projectRoot: onDisk.path,
      })
    );
    if (!report.valid) {
      throw new ArchiveBlockedError(
        'archive_validation_failed',
        `Validation failed for change '${changeName}'.`,
        `Run openspec validate ${changeName} for details, fix the errors, or rerun with --no-validate.`
      );
    }
  }

  // The same refusal upstream gives for an unchecked file item, over the task tuples.
  const tasks = await store.listTasks(changeName);
  const incompleteTasks = tasks.filter((task) => !task.done).length;
  if (incompleteTasks > 0 && !options.yes) {
    throw new ArchiveBlockedError(
      'archive_tasks_incomplete',
      `${incompleteTasks} incomplete task(s) found for change '${changeName}'.`,
      'Complete the tasks or rerun with --yes.'
    );
  }

  let specsUpdated = false;
  const totals = { added: 0, modified: 0, removed: 0, renamed: 0 };
  const warnings: string[] = [];
  if (!options.skipSpecs) {
    const retirementDeclared = (await store.readMarker(changeName, 'retire_capabilities')).declared;
    // The merge code reads delta files, so the change is exported for the
    // duration; the targets it writes are the real main specs.
    const built = await withChangeOnDisk(store, changeName, async (onDisk) => {
      const updates = await findSpecUpdates(path.join(onDisk.changesDir, changeName), specsDir);
      const prepared: Array<{
        target: string;
        id: string;
        rebuilt: string;
        counts: {
          added: number;
          modified: number;
          removed: number;
          renamed: number;
        };
        noRequirementBlocks: boolean;
        warnings: string[];
      }> = [];
      for (const update of updates) {
        const result = await buildUpdatedSpec(update, changeName, {
          silent: true,
        });
        prepared.push({
          target: update.target,
          id: update.id,
          rebuilt: result.rebuilt,
          counts: result.counts,
          noRequirementBlocks: result.noRequirementBlocks,
          warnings: result.warnings,
        });
      }
      return prepared;
    });

    for (const spec of built) {
      warnings.push(...spec.warnings);
      if (spec.noRequirementBlocks) {
        if (!retirementDeclared) {
          throw new ArchiveBlockedError(
            'archive_spec_would_be_empty',
            `The merge would leave '${spec.id}' with no requirements.`,
            `Declare retire_capabilities: true in the change's metadata to retire the capability, or fix the delta.`
          );
        }
        await fs.rm(spec.target, { force: true });
      } else {
        await fs.mkdir(path.dirname(spec.target), { recursive: true });
        await fs.writeFile(spec.target, spec.rebuilt, 'utf-8');
      }
      totals.added += spec.counts.added;
      totals.modified += spec.counts.modified;
      totals.removed += spec.counts.removed;
      totals.renamed += spec.counts.renamed;
      specsUpdated = true;
    }
  }

  // Every live tuple of the change: artefacts, open tasks, and anything else
  // posted on its subject. Completed tasks are retired already.
  const live = await store.client.search({
    subjects: [store.changeSubject(changeName), `repo:${store.board.repo}`],
    limit: 2000,
  });
  let archivedTuples = 0;
  for (const tuple of live.items) {
    await store.client.archive(tuple.id);
    archivedTuples += 1;
  }

  return {
    change: changeName,
    archivedAs: store.changeSubject(changeName),
    path: `${store.board.url}/board (${store.changeSubject(changeName)})`,
    specsUpdated,
    ...(specsUpdated ? { totals } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    archivedTuples,
  };
}
