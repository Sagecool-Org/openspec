/**
 * The change-store port: every read and write of a change's artefacts goes
 * through one of these, so that a change can live in `openspec/changes/<name>/`
 * (the upstream file layout, `FileChangeStore`) or on an Agora board
 * (`BoardChangeStore`, selected by `.agora.json`) without the commands knowing
 * which. The pure core (artifact graph, parsers, task counting, spec merging)
 * stays untouched; only the storage of a change is behind this seam.
 *
 * Names in this interface follow design D2 of the board-backed-openspec change.
 * `openspec store` (registered root directories) is a different concept: a
 * registered store is still a file layout and uses `FileChangeStore`.
 */

import type { ChangeMetadata } from '../change-metadata/schema.js';
import type { MetadataMarker } from '../../utils/change-metadata.js';
import type { DiscoveredSpec } from '../../utils/spec-discovery.js';
import type { CreateChangeOptions, CreateChangeResult } from '../../utils/change-utils.js';
import type { ArchiveOptions } from '../archive.js';

export type ChangeStoreKind = 'file' | 'board';

/** The boolean markers `.openspec.yaml` can declare, read fail-closed. */
export type MetadataMarkerName = 'skip_specs' | 'retire_capabilities';

/**
 * One checklist item of the tasks artefact. On the file store the id is the
 * ordinal as text; on the board it is the task tuple's id.
 */
export interface StoredTask {
  ordinal: number;
  id: string;
  description: string;
  done: boolean;
}

export interface WriteArtifactOptions {
  /**
   * The version the caller read before writing. A store with versions refuses
   * a write whose base is no longer current unless `force` is set; the file
   * store has no versions and ignores both.
   */
  base?: string;
  force?: boolean;
}

export interface WriteArtifactResult {
  /** The written version's identity: the file path, or the tuple id. */
  id: string;
}

export type ArchiveChangeOptions = Omit<ArchiveOptions, 'store' | 'storePath'>;

/**
 * What a change holds, read once: its validated metadata (null when it has
 * none) and the relative paths of the artefacts that exist, in the upstream
 * layout (`proposal.md`, `specs/<capability>/spec.md`). The synchronous
 * artifact-graph code works from this where it would otherwise stat files.
 */
export interface ChangeSnapshot {
  exists: boolean;
  metadata: ChangeMetadata | null;
  outputs: string[];
}

export interface ChangeStore {
  readonly kind: ChangeStoreKind;
  /** The repository root: `openspec/specs/` and `openspec/config.yaml` live under it on every store. */
  readonly projectRoot: string;
  /**
   * Where changes live. On the file store a real directory; on the board the
   * `source` prefix the JSON contract keeps (`openspec/changes`), which no
   * command expects to exist on disk.
   */
  readonly changesDir: string;

  listChanges(): Promise<string[]>;
  changeExists(name: string): Promise<boolean>;
  createChange(name: string, options?: Omit<CreateChangeOptions, 'changesDir'>): Promise<CreateChangeResult>;

  readMetadata(name: string): Promise<ChangeMetadata | null>;
  writeMetadata(name: string, metadata: ChangeMetadata): Promise<void>;
  /**
   * A marker read never throws: an unreadable or invalid metadata file is
   * reported through `invalidReason` so callers fail closed. This is a
   * different contract from `readMetadata`, which throws on any defect.
   */
  readMarker(name: string, marker: MetadataMarkerName): Promise<MetadataMarker>;

  /** The artefact outputs a schema `generates` pattern resolves to for the change. */
  resolveOutputs(name: string, generates: string): Promise<string[]>;
  outputExists(name: string, generates: string): Promise<boolean>;

  /** The current content of an artefact, or null when it does not exist yet. */
  readArtifact(name: string, artifactPath: string): Promise<string | null>;
  writeArtifact(
    name: string,
    artifactPath: string,
    content: string,
    options?: WriteArtifactOptions
  ): Promise<WriteArtifactResult>;

  /** The change's delta specs, one per capability. */
  listDeltaSpecs(name: string): Promise<DiscoveredSpec[]>;
  /** The delta specs whose capability has no main spec under `openspec/specs/` yet. */
  listUnreadDeltas(name: string): Promise<DiscoveredSpec[]>;
  /** Whether the change holds anything at all beyond its own existence. */
  hasAnyContent(name: string): Promise<boolean>;

  listTasks(name: string): Promise<StoredTask[]>;
  /** Reserve a task for the caller. The file store has no leases and returns the task unchanged. */
  takeTask(name: string, ordinal: number): Promise<StoredTask>;
  completeTask(name: string, ordinal: number): Promise<StoredTask>;
  /** Give a reserved task back. The file store has no leases and returns the task unchanged. */
  releaseTask(name: string, ordinal: number): Promise<StoredTask>;

  archiveChange(name: string, options?: ArchiveChangeOptions): Promise<void>;
  /** When the change last changed, or null when it has no content to date. */
  changeLastModified(name: string): Promise<Date | null>;

  /** The change's metadata and existing artefacts, read once. */
  snapshot(name: string): Promise<ChangeSnapshot>;
  /**
   * Writes the current version of every artefact of the change into
   * `targetDir` in the upstream layout: how a read-only file-shaped command
   * sees a change from any store, and how `board export` returns one to files.
   */
  exportChange(name: string, targetDir: string): Promise<void>;
}
