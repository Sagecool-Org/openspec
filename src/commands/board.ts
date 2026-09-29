/**
 * `openspec board import|export|refresh`: moving a change between the file
 * layout and the board, and keeping a board change alive past its tuples'
 * expiry. Every subcommand needs a root that declares a board.
 */

import type { Command } from 'commander';
import path from 'path';
import { COMMAND_REGISTRY } from '../core/completions/command-registry.js';
import { BoardChangeStore, FileChangeStore } from '../core/change-store/index.js';
import { exportChangeFromBoard, importChangeToBoard, refreshChange } from '../core/change-store/board-migration.js';
import {
  resolveRootForCommand,
  toRootOutput,
  type ResolvedOpenSpecRoot,
  type StoreSelectorOptions,
} from '../core/root-selection.js';
import { COMMON_FLAGS } from '../core/completions/shared-flags.js';
import { asStatus } from './shared-output.js';
import { printJson } from './workflow/shared.js';

interface BoardCommandOptions extends StoreSelectorOptions {
  json?: boolean;
}

function boardStoreOf(root: ResolvedOpenSpecRoot): BoardChangeStore {
  if (!(root.store instanceof BoardChangeStore)) {
    throw new Error(
      `This root declares no board: ${path.join(root.path, '.agora.json')} does not exist. ` +
        'The board commands move a change between openspec/changes/ and the board a repository declares.'
    );
  }
  return root.store;
}

function fail(error: unknown, change: string, json: boolean | undefined, code: string): void {
  if (json) {
    printJson({ change, status: [asStatus(error, code)] });
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}

export async function boardImportCommand(change: string, options: BoardCommandOptions): Promise<void> {
  const root = await resolveRootForCommand(options, {
    json: options.json,
    failurePayload: { change },
  });
  if (!root) return;
  const board = boardStoreOf(root);
  const source = new FileChangeStore({
    projectRoot: root.path,
    changesDir: root.changesDir,
    specsDir: root.specsDir,
  });
  const result = await importChangeToBoard(board, source, change);
  if (options.json) {
    printJson({ ...result, root: toRootOutput(root) });
    return;
  }
  console.log(`Imported change '${change}' to the board at ${board.board.url}:`);
  for (const artefact of result.artefacts) console.log(`  ${artefact.path}  ${artefact.id}`);
  for (const task of result.tasks) console.log(`  tasks.md#${task.ordinal}${task.done ? ' [x]' : ' [ ]'}  ${task.id}`);
  console.log(`The directory ${path.join(root.changesDir, change)} is yours to remove.`);
}

export async function boardExportCommand(change: string, options: BoardCommandOptions): Promise<void> {
  const root = await resolveRootForCommand(options, {
    json: options.json,
    failurePayload: { change },
  });
  if (!root) return;
  const board = boardStoreOf(root);
  const result = await exportChangeFromBoard(board, change);
  if (options.json) {
    printJson({ ...result, root: toRootOutput(root) });
    return;
  }
  console.log(`Exported change '${change}' to ${result.directory} (${result.files.length} file(s)).`);
}

export async function boardRefreshCommand(change: string, options: BoardCommandOptions): Promise<void> {
  const root = await resolveRootForCommand(options, {
    json: options.json,
    failurePayload: { change },
  });
  if (!root) return;
  const board = boardStoreOf(root);
  const result = await refreshChange(board, change);
  if (options.json) {
    printJson({ ...result, root: toRootOutput(root) });
    return;
  }
  if (result.refreshed.length === 0) {
    console.log(`Nothing of change '${change}' expires before ${result.threshold}.`);
    return;
  }
  console.log(
    `Refreshed ${result.refreshed.length} tuple(s) of change '${change}' expiring before ${result.threshold}:`
  );
  for (const entry of result.refreshed) console.log(`  ${entry.path}  ${entry.previousId} -> ${entry.id}`);
}

export function registerBoardCommand(
  program: Command,
  storeOption: { description: string; hidden: () => unknown }
): void {
  const description =
    COMMAND_REGISTRY.find((entry) => entry.name === 'board')?.description ??
    'Move a change between openspec/changes/ and the board the repository declares';
  const board = program.command('board').description(description);

  const subcommands: Array<[string, string, (change: string, options: BoardCommandOptions) => Promise<void>, string]> =
    [
      [
        'import',
        'Post a change directory to the board as tuples (checked tasks completed) and print their ids',
        boardImportCommand,
        'board_import_error',
      ],
      [
        'export',
        'Write the current version of every artefact of a board change back to openspec/changes/',
        boardExportCommand,
        'board_export_error',
      ],
      [
        'refresh',
        'Re-post the tuples of a board change that expire within seven days',
        boardRefreshCommand,
        'board_refresh_error',
      ],
    ];
  for (const [name, text, run, code] of subcommands) {
    const command = board.command(`${name} <change>`).description(text).option('--json', COMMON_FLAGS.json.description);
    command.option('--store <id>', storeOption.description);
    command.addOption(storeOption.hidden() as never);
    command.action(async (change: string, options: BoardCommandOptions) => {
      try {
        await run(change, options);
      } catch (error) {
        fail(error, change, options.json, code);
      }
    });
  }
}
