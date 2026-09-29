import path from 'node:path';
import type { ChangeMetadata } from '../change-metadata/schema.js';
import {
  markerFromMetadataText,
  parseChangeMetadataText,
  serializeChangeMetadata,
  validateSchemaName,
  type MetadataMarker,
} from '../../utils/change-metadata.js';
import type { DiscoveredSpec } from '../../utils/spec-discovery.js';
import { validateChangeName, type CreateChangeOptions, type CreateChangeResult } from '../../utils/change-utils.js';
import { formatLocalDate } from '../../utils/date.js';
import { FileSystemUtils } from '../../utils/file-system.js';
import { readProjectConfig } from '../project-config.js';
import { resolveSchema } from '../artifact-graph/resolver.js';
import { isSpecsArtifactPath } from '../artifact-graph/outputs.js';
import { BoardClient, type BoardTuple } from './board-client.js';
import type { BoardConfig } from './board-config.js';
import { BoardSession, type GitRunner } from './board-conventions.js';
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
  /** A client to reuse, for tests and for callers that already hold one. */
  client?: BoardClient;
  git?: GitRunner;
}

const DEFAULT_SCHEMA = 'spec-driven';
const METADATA_FILENAME = '.openspec.yaml';

/**
 * Thrown by an operation the board store does not perform yet (tasks 4.x of
 * board-backed-openspec land them one group at a time). A caller that reaches
 * one fails naming the board rather than reading files in its place.
 */
export class BoardStoreUnavailableError extends Error {
  constructor(
    public readonly board: BoardConfig,
    operation: string
  ) {
    super(
      `The board change store cannot ${operation} yet: ${board.configPath} declares the board at ${board.url} ` +
        `for repository "${board.repo}", and this build of openspec holds no such board operation.`
    );
    this.name = 'BoardStoreUnavailableError';
  }
}

/** The fenced YAML block a metadata artefact carries under its summary line. */
const METADATA_BLOCK = /```yaml\r?\n([\s\S]*?)```/;

/** The YAML text of a metadata artefact tuple's body. */
export function metadataTextFromContent(content: string): string {
  const fenced = content.match(METADATA_BLOCK);
  if (fenced) return fenced[1];
  const blank = content.indexOf('\n\n');
  return blank === -1 ? content : content.slice(blank + 2);
}

/** A metadata artefact's body: one summary line everyone reads, then the YAML as it would be on disk. */
export function renderMetadataContent(name: string, metadata: ChangeMetadata, yamlText: string): string {
  const created = metadata.created ? `, created ${metadata.created}` : '';
  return `${name} metadata: schema ${metadata.schema}${created}.\n\n\`\`\`yaml\n${yamlText}\`\`\``;
}

/**
 * A change stored as tuples on the Agora board named by `.agora.json`. Each
 * artefact is one tuple on `change:<name>` carrying `sdd`, `schema`,
 * `artifact` and `source`; a revision is a new tuple linked `supersedes` to
 * the live one, so a default search sees the newest and the trail the rest.
 * `changesDir` keeps the upstream layout so the JSON contract's paths stay
 * readable; nothing is expected to exist there on disk.
 */
export class BoardChangeStore implements ChangeStore {
  readonly kind = 'board' as const;
  readonly projectRoot: string;
  readonly changesDir: string;
  readonly board: BoardConfig;
  readonly client: BoardClient;
  readonly session: BoardSession;

  constructor(options: BoardChangeStoreOptions) {
    this.projectRoot = options.projectRoot;
    this.changesDir = path.join(options.projectRoot, 'openspec', 'changes');
    this.board = options.board;
    this.client = options.client ?? new BoardClient({ board: options.board });
    this.session = new BoardSession(this.client, {
      projectRoot: options.projectRoot,
      git: options.git,
    });
  }

  private unavailable(operation: string): never {
    throw new BoardStoreUnavailableError(this.board, operation);
  }

  // ---------------------------------------------------------------------------
  // Addressing
  // ---------------------------------------------------------------------------

  changeSubject(name: string): string {
    return `change:${name}`;
  }

  /** Where the artefact would live under the upstream layout: the `source` key and the JSON contract's path. */
  sourceOf(name: string, relativePath: string): string {
    return path.posix.join('openspec', 'changes', name, relativePath);
  }

  /** The live tuples of one artefact kind of a change, newest first, scoped to this repository on the board. */
  async liveArtefacts(name: string, artifact: string): Promise<BoardTuple[]> {
    const result = await this.client.search({
      subjects: [this.changeSubject(name), `repo:${this.board.repo}`],
      where: { kind: 'artefact', artifact },
      limit: 100,
    });
    return [...result.items].sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
  }

  private async metadataTuple(name: string): Promise<BoardTuple | null> {
    const [newest] = await this.liveArtefacts(name, 'metadata');
    return newest ?? null;
  }

  // ---------------------------------------------------------------------------
  // Changes and metadata
  // ---------------------------------------------------------------------------

  async listChanges(): Promise<string[]> {
    return this.unavailable('list changes');
  }

  async changeExists(name: string): Promise<boolean> {
    return (await this.metadataTuple(name)) !== null;
  }

  /**
   * Posts the metadata tuple and creates no directory. The root's own files
   * (`openspec/specs/`, `openspec/config.yaml`) are still scaffolded as the
   * file store does, because the specs stay in git on every store.
   */
  async createChange(name: string, options: Omit<CreateChangeOptions, 'changesDir'> = {}): Promise<CreateChangeResult> {
    const validation = validateChangeName(name);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const defaultSchema = options.defaultSchema ?? DEFAULT_SCHEMA;
    let schemaName: string;
    if (options.schema) {
      schemaName = options.schema;
    } else {
      try {
        schemaName = readProjectConfig(this.projectRoot)?.schema ?? defaultSchema;
      } catch {
        schemaName = defaultSchema;
      }
    }
    validateSchemaName(schemaName, this.projectRoot);

    if (await this.changeExists(name)) {
      throw new Error(`Change '${name}' already exists on the board at ${this.board.url}`);
    }

    const schema = resolveSchema(schemaName, this.projectRoot);
    const skipsSpecs = !schema.artifacts.some((artifact) => isSpecsArtifactPath(artifact.generates));

    const openspecDir = path.join(this.projectRoot, 'openspec');
    await FileSystemUtils.createDirectory(path.join(openspecDir, 'specs'));
    const configPath = path.join(openspecDir, 'config.yaml');
    const configYmlPath = path.join(openspecDir, 'config.yml');
    if (!(await FileSystemUtils.fileExists(configPath)) && !(await FileSystemUtils.fileExists(configYmlPath))) {
      await FileSystemUtils.writeFile(configPath, `schema: ${defaultSchema}\n`);
    }

    await this.writeMetadata(name, {
      schema: schemaName,
      created: formatLocalDate(),
      ...(skipsSpecs ? { skip_specs: true } : {}),
      ...options.metadata,
    });

    return { schema: schemaName, changeDir: path.join(this.changesDir, name) };
  }

  async readMetadata(name: string): Promise<ChangeMetadata | null> {
    const tuple = await this.metadataTuple(name);
    if (!tuple) return null;
    return parseChangeMetadataText(
      metadataTextFromContent(tuple.content),
      this.sourceOf(name, METADATA_FILENAME),
      this.projectRoot
    );
  }

  async writeMetadata(name: string, metadata: ChangeMetadata): Promise<void> {
    const source = this.sourceOf(name, METADATA_FILENAME);
    const yamlText = serializeChangeMetadata(metadata, source, this.projectRoot);
    const live = await this.metadataTuple(name);
    await this.session.post({
      kind: 'artefact',
      subjects: [this.changeSubject(name)],
      content: renderMetadataContent(name, metadata, yamlText),
      slug: `${name} metadata`,
      tags: ['topic:openspec'],
      ...(live ? { links: [`supersedes:${live.id}`] } : {}),
      sdd: 'openspec',
      schema: metadata.schema,
      artifact: 'metadata',
      source,
    });
  }

  async readMarker(name: string, marker: MetadataMarkerName): Promise<MetadataMarker> {
    const tuple = await this.metadataTuple(name);
    if (!tuple) return { declared: false };
    return markerFromMetadataText(metadataTextFromContent(tuple.content), marker, this.projectRoot);
  }

  // ---------------------------------------------------------------------------
  // Not yet on the board
  // ---------------------------------------------------------------------------

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
