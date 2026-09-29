import fs from 'node:fs';
import path from 'node:path';
import { FileSystemUtils } from '../../utils/file-system.js';
import {
  readChangeMetadata,
  writeChangeMetadata,
  readSkipSpecsMarker,
  readRetireCapabilitiesMarker,
  type MetadataMarker,
} from '../../utils/change-metadata.js';
import type { ChangeMetadata } from '../change-metadata/schema.js';
import { resolveArtifactOutputs, artifactOutputExists } from '../artifact-graph/outputs.js';
import { discoverSpecFiles, hasAnyFileUnder, type DiscoveredSpec } from '../../utils/spec-discovery.js';
import { createChange, type CreateChangeOptions, type CreateChangeResult } from '../../utils/change-utils.js';
import { parseTaskLines, resolveTaskFilesForChange, TASK_LINE_PATTERN } from '../../utils/task-progress.js';
import { getLastModified } from '../list.js';
import type { ResolvedOpenSpecRoot } from '../root-selection.js';
import type {
  ArchiveChangeOptions,
  ChangeStore,
  MetadataMarkerName,
  StoredTask,
  WriteArtifactOptions,
  WriteArtifactResult,
} from './types.js';

export interface FileChangeStoreDirectories {
  projectRoot: string;
  changesDir?: string;
  specsDir?: string;
  /** The registered store id when the root was selected with `--store`. */
  storeId?: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * The upstream layout behind the change-store port: a change is the directory
 * `<changesDir>/<name>/`, its artefacts are files, its tasks are checklist
 * lines. Every method delegates to the module that already implemented that
 * behaviour, so the upstream tests keep guarding it.
 */
export class FileChangeStore implements ChangeStore {
  readonly kind = 'file' as const;
  readonly projectRoot: string;
  readonly changesDir: string;
  readonly specsDir: string;
  private readonly storeId: string | undefined;

  constructor(directories: FileChangeStoreDirectories) {
    this.projectRoot = directories.projectRoot;
    this.changesDir = directories.changesDir ?? path.join(directories.projectRoot, 'openspec', 'changes');
    this.specsDir = directories.specsDir ?? path.join(directories.projectRoot, 'openspec', 'specs');
    this.storeId = directories.storeId;
  }

  static forRoot(root: ResolvedOpenSpecRoot): FileChangeStore {
    return new FileChangeStore({
      projectRoot: root.path,
      changesDir: root.changesDir,
      specsDir: root.specsDir,
      storeId: root.storeId,
    });
  }

  changeDir(name: string): string {
    return path.join(this.changesDir, name);
  }

  async listChanges(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.changesDir, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
  }

  async changeExists(name: string): Promise<boolean> {
    const changePath = this.changeDir(name);
    return fs.existsSync(changePath) && fs.statSync(changePath).isDirectory();
  }

  async createChange(name: string, options: Omit<CreateChangeOptions, 'changesDir'> = {}): Promise<CreateChangeResult> {
    return createChange(this.projectRoot, name, {
      ...options,
      changesDir: this.changesDir,
    });
  }

  async readMetadata(name: string): Promise<ChangeMetadata | null> {
    return readChangeMetadata(this.changeDir(name), this.projectRoot);
  }

  async writeMetadata(name: string, metadata: ChangeMetadata): Promise<void> {
    writeChangeMetadata(this.changeDir(name), metadata, this.projectRoot);
  }

  async readMarker(name: string, marker: MetadataMarkerName): Promise<MetadataMarker> {
    const changeDir = this.changeDir(name);
    return marker === 'skip_specs'
      ? readSkipSpecsMarker(changeDir, this.projectRoot)
      : readRetireCapabilitiesMarker(changeDir, this.projectRoot);
  }

  async resolveOutputs(name: string, generates: string): Promise<string[]> {
    return resolveArtifactOutputs(this.changeDir(name), generates);
  }

  async outputExists(name: string, generates: string): Promise<boolean> {
    return artifactOutputExists(this.changeDir(name), generates);
  }

  private artifactFile(name: string, artifactPath: string): string {
    const changeDir = this.changeDir(name);
    const file = path.join(changeDir, artifactPath);
    FileSystemUtils.assertPathWithin(changeDir, file);
    return file;
  }

  async readArtifact(name: string, artifactPath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.artifactFile(name, artifactPath), 'utf-8');
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async writeArtifact(
    name: string,
    artifactPath: string,
    content: string,
    _options: WriteArtifactOptions = {}
  ): Promise<WriteArtifactResult> {
    const file = this.artifactFile(name, artifactPath);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content, 'utf-8');
    return { id: file };
  }

  async listDeltaSpecs(name: string): Promise<DiscoveredSpec[]> {
    return discoverSpecFiles(path.join(this.changeDir(name), 'specs'));
  }

  async listUnreadDeltas(name: string): Promise<DiscoveredSpec[]> {
    const deltas = await this.listDeltaSpecs(name);
    return deltas.filter((delta) => !fs.existsSync(path.join(this.specsDir, delta.id, 'spec.md')));
  }

  async hasAnyContent(name: string): Promise<boolean> {
    return hasAnyFileUnder(this.changeDir(name));
  }

  private taskFiles(name: string): string[] {
    const changeDir = this.changeDir(name);
    const files = resolveTaskFilesForChange(changeDir, this.projectRoot);
    return files.length > 0 ? files : [path.join(changeDir, 'tasks.md')];
  }

  async listTasks(name: string): Promise<StoredTask[]> {
    const tasks: StoredTask[] = [];
    for (const file of this.taskFiles(name)) {
      let content: string;
      try {
        content = await fs.promises.readFile(file, 'utf-8');
      } catch (error: unknown) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      for (const parsed of parseTaskLines(content)) {
        const ordinal = tasks.length + 1;
        tasks.push({
          ordinal,
          id: String(ordinal),
          description: parsed.description,
          done: parsed.done,
        });
      }
    }
    return tasks;
  }

  private async findTask(name: string, ordinal: number): Promise<StoredTask> {
    const task = (await this.listTasks(name)).find((candidate) => candidate.ordinal === ordinal);
    if (!task) {
      throw new Error(`Task ${ordinal} not found in change '${name}'`);
    }
    return task;
  }

  async takeTask(name: string, ordinal: number): Promise<StoredTask> {
    return this.findTask(name, ordinal);
  }

  async releaseTask(name: string, ordinal: number): Promise<StoredTask> {
    return this.findTask(name, ordinal);
  }

  /**
   * Ticks the checklist line at `ordinal`, counting task lines across the
   * change's task files in order, exactly as `listTasks` numbers them.
   */
  async completeTask(name: string, ordinal: number): Promise<StoredTask> {
    let seen = 0;
    for (const file of this.taskFiles(name)) {
      let content: string;
      try {
        content = await fs.promises.readFile(file, 'utf-8');
      } catch (error: unknown) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(TASK_LINE_PATTERN);
        if (!match) continue;
        seen += 1;
        if (seen !== ordinal) continue;
        const description = match[2].trim();
        if (match[1].toLowerCase() !== 'x') {
          lines[index] = lines[index].replace(/\[[\sxX]\]/, '[x]');
          await fs.promises.writeFile(file, lines.join('\n'), 'utf-8');
        }
        return { ordinal, id: String(ordinal), description, done: true };
      }
    }
    throw new Error(`Task ${ordinal} not found in change '${name}'`);
  }

  async archiveChange(name: string, options: ArchiveChangeOptions = {}): Promise<void> {
    // Imported here, not at the top: archive resolves roots, and roots now
    // carry this store, so a static import would be a cycle.
    const { ArchiveCommand } = await import('../archive.js');
    await new ArchiveCommand().execute(name, {
      ...options,
      ...(this.storeId !== undefined ? { store: this.storeId } : {}),
    });
  }

  async changeLastModified(name: string): Promise<Date | null> {
    try {
      return await getLastModified(this.changeDir(name));
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }
}
