import path from 'node:path';
import type { ChangeMetadata } from '../change-metadata/schema.js';
import type { MetadataMarker } from '../../utils/change-metadata.js';
import type { DiscoveredSpec } from '../../utils/spec-discovery.js';
import type { CreateChangeOptions, CreateChangeResult } from '../../utils/change-utils.js';
import type { BoardConfig } from './board-config.js';
import type {
  ArchiveChangeOptions,
  ChangeStore,
  MetadataMarkerName,
  StoredTask,
  WriteArtifactOptions,
  WriteArtifactResult,
} from './types.js';

export interface BoardChangeStoreOptions {
  projectRoot: string;
  board: BoardConfig;
}

/**
 * Thrown by every operation until the board client and the tuple-backed
 * operations land (tasks 3.x and 4.x of board-backed-openspec). A root that
 * declares a board already selects this store and reports `kind: board`, so
 * the selection can be verified end to end before the operations exist; no
 * command reaches these methods yet, and one that does fails naming the board
 * rather than reading files in its place.
 */
export class BoardStoreUnavailableError extends Error {
  constructor(
    public readonly board: BoardConfig,
    operation: string
  ) {
    super(
      `The board change store cannot ${operation} yet: ${board.configPath} declares the board at ${board.url} ` +
        `for repository "${board.repo}", and this build of openspec holds no board operations.`
    );
    this.name = 'BoardStoreUnavailableError';
  }
}

/**
 * A change stored as tuples on the Agora board named by `.agora.json`.
 * `changesDir` keeps the upstream `source` prefix so paths in the JSON
 * contract stay readable; nothing is expected to exist there on disk.
 */
export class BoardChangeStore implements ChangeStore {
  readonly kind = 'board' as const;
  readonly projectRoot: string;
  readonly changesDir: string;
  readonly board: BoardConfig;

  constructor(options: BoardChangeStoreOptions) {
    this.projectRoot = options.projectRoot;
    this.changesDir = path.join(options.projectRoot, 'openspec', 'changes');
    this.board = options.board;
  }

  private unavailable(operation: string): never {
    throw new BoardStoreUnavailableError(this.board, operation);
  }

  async listChanges(): Promise<string[]> {
    return this.unavailable('list changes');
  }

  async changeExists(_name: string): Promise<boolean> {
    return this.unavailable('check whether a change exists');
  }

  async createChange(_name: string, _options?: Omit<CreateChangeOptions, 'changesDir'>): Promise<CreateChangeResult> {
    return this.unavailable('create a change');
  }

  async readMetadata(_name: string): Promise<ChangeMetadata | null> {
    return this.unavailable('read metadata');
  }

  async writeMetadata(_name: string, _metadata: ChangeMetadata): Promise<void> {
    return this.unavailable('write metadata');
  }

  async readMarker(_name: string, _marker: MetadataMarkerName): Promise<MetadataMarker> {
    return this.unavailable('read a marker');
  }

  async resolveOutputs(_name: string, _generates: string): Promise<string[]> {
    return this.unavailable('resolve artefact outputs');
  }

  async outputExists(_name: string, _generates: string): Promise<boolean> {
    return this.unavailable('check an artefact output');
  }

  async readArtifact(_name: string, _artifactPath: string): Promise<string | null> {
    return this.unavailable('read an artefact');
  }

  async writeArtifact(
    _name: string,
    _artifactPath: string,
    _content: string,
    _options?: WriteArtifactOptions
  ): Promise<WriteArtifactResult> {
    return this.unavailable('write an artefact');
  }

  async listDeltaSpecs(_name: string): Promise<DiscoveredSpec[]> {
    return this.unavailable('list delta specs');
  }

  async listUnreadDeltas(_name: string): Promise<DiscoveredSpec[]> {
    return this.unavailable('list unread delta specs');
  }

  async hasAnyContent(_name: string): Promise<boolean> {
    return this.unavailable('check for content');
  }

  async listTasks(_name: string): Promise<StoredTask[]> {
    return this.unavailable('list tasks');
  }

  async takeTask(_name: string, _ordinal: number): Promise<StoredTask> {
    return this.unavailable('take a task');
  }

  async completeTask(_name: string, _ordinal: number): Promise<StoredTask> {
    return this.unavailable('complete a task');
  }

  async releaseTask(_name: string, _ordinal: number): Promise<StoredTask> {
    return this.unavailable('release a task');
  }

  async archiveChange(_name: string, _options?: ArchiveChangeOptions): Promise<void> {
    return this.unavailable('archive a change');
  }

  async changeLastModified(_name: string): Promise<Date | null> {
    return this.unavailable('read when a change last changed');
  }
}
