import fs from 'node:fs';
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
import { matchOutputs } from './generates-glob.js';
import type {
  ArchiveChangeOptions,
  ChangeSnapshot,
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
 * A write whose base is no longer the live version. The caller re-reads the
 * live tuple, merges, and writes again with its id as the base; `force` skips
 * the check. This is the only concurrency control on artefacts (design D4).
 */
export class StaleArtifactError extends Error {
  constructor(
    public readonly change: string,
    public readonly artifactPath: string,
    public readonly base: string,
    public readonly liveId: string | null
  ) {
    super(
      liveId
        ? `${artifactPath} of change '${change}' has moved on: the live version is ${liveId}, not ${base}. Re-read it and write again with --base ${liveId}, or pass --force.`
        : `${artifactPath} of change '${change}' no longer has a live version to revise (base ${base}). Write without --base to post it afresh, or pass --force.`
    );
    this.name = 'StaleArtifactError';
  }
}

/** The `artifact` (and `capability`) keys an artefact path carries on the board. */
export function artifactKeysFor(relativePath: string): { artifact: string; capability?: string } {
  const posix = relativePath.split(path.sep).join('/');
  const spec = posix.match(/^specs\/(.+)\/spec\.md$/);
  if (spec) return { artifact: 'spec', capability: spec[1] };
  if (posix === METADATA_FILENAME) return { artifact: 'metadata' };
  const base = path.posix.basename(posix).replace(/\.[^.]+$/, '');
  return { artifact: base.toLowerCase().replace(/[^a-z0-9]+/g, '-') };
}

const SUMMARY_MAX = 200;

/** The one-line summary everyone reads: the change, the artefact, and the markdown's first line. */
export function artifactSummary(name: string, relativePath: string, markdown: string): string {
  const { artifact, capability } = artifactKeysFor(relativePath);
  const label = capability ? `${capability} delta spec` : `${name} ${artifact}`;
  const firstLine =
    markdown
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line !== '') ?? '';
  const summary = firstLine ? `${label}: ${firstLine}` : label;
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : summary;
}

/** An artefact tuple's body: the summary, a blank line, the markdown exactly as the file would hold it. */
export function renderArtifactContent(summary: string, markdown: string): string {
  return `${summary}\n\n${markdown}`;
}

/** The markdown of an artefact tuple's body, without its summary line. */
export function artifactTextFromContent(content: string): string {
  const blank = content.indexOf('\n\n');
  return blank === -1 ? '' : content.slice(blank + 2);
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

  /** Every live artefact tuple of a change, newest first. */
  async allLiveArtefacts(name: string): Promise<BoardTuple[]> {
    const result = await this.client.search({
      subjects: [this.changeSubject(name), `repo:${this.board.repo}`],
      where: { kind: 'artefact' },
      limit: 1000,
    });
    return [...result.items].sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
  }

  /** The path an artefact tuple would have under `openspec/changes/<name>/`, from its `source`. */
  relativePathOf(name: string, tuple: BoardTuple): string | null {
    const source = tuple.map?.source;
    if (typeof source !== 'string') return null;
    const prefix = `openspec/changes/${name}/`;
    return source.startsWith(prefix) ? source.slice(prefix.length) : null;
  }

  private async metadataTuple(name: string): Promise<BoardTuple | null> {
    const [newest] = await this.liveArtefacts(name, 'metadata');
    return newest ?? null;
  }

  /** The live tuple of one artefact file of a change, found by its `source`, or null. */
  async liveArtefact(name: string, relativePath: string): Promise<BoardTuple | null> {
    const result = await this.client.search({
      subjects: [this.changeSubject(name), `repo:${this.board.repo}`],
      where: { kind: 'artefact', source: this.sourceOf(name, relativePath) },
      limit: 10,
    });
    const [newest] = [...result.items].sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
    return newest ?? null;
  }

  // ---------------------------------------------------------------------------
  // Changes and metadata
  // ---------------------------------------------------------------------------

  /** Every change with a live metadata tuple in this repository on the board, sorted. */
  async listChanges(): Promise<string[]> {
    const result = await this.client.search({
      subjects: [`repo:${this.board.repo}`],
      where: { kind: 'artefact', artifact: 'metadata' },
      limit: 1000,
    });
    const names = new Set<string>();
    for (const tuple of result.items) {
      for (const subject of tuple.subjects) {
        if (subject.startsWith('change:')) names.add(subject.slice('change:'.length));
      }
    }
    return [...names].sort();
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

  // ---------------------------------------------------------------------------
  // What the change holds
  // ---------------------------------------------------------------------------

  async snapshot(name: string): Promise<ChangeSnapshot> {
    const tuples = await this.allLiveArtefacts(name);
    const metadataTuple = tuples.find((tuple) => tuple.map?.artifact === 'metadata') ?? null;
    const outputs = tuples
      .map((tuple) => this.relativePathOf(name, tuple))
      .filter((relative): relative is string => relative !== null)
      .sort();
    const metadata = metadataTuple
      ? parseChangeMetadataText(
          metadataTextFromContent(metadataTuple.content),
          this.sourceOf(name, METADATA_FILENAME),
          this.projectRoot
        )
      : null;
    return { exists: tuples.length > 0, metadata, outputs: [...new Set(outputs)] };
  }

  async resolveOutputs(name: string, generates: string): Promise<string[]> {
    const { outputs } = await this.snapshot(name);
    return matchOutputs(outputs, generates).map((relative) => path.join(this.changesDir, name, ...relative.split('/')));
  }

  async outputExists(name: string, generates: string): Promise<boolean> {
    return (await this.resolveOutputs(name, generates)).length > 0;
  }

  /**
   * Writes every live artefact as the file it would be, for read-only commands
   * that still think in files and for `board export`. The tasks artefact is
   * written as its text; rendering checkboxes from task tuples arrives with
   * the task operations.
   */
  async exportChange(name: string, targetDir: string): Promise<void> {
    const tuples = await this.allLiveArtefacts(name);
    if (tuples.length === 0) {
      throw new Error(`Change '${name}' is not on the board at ${this.board.url}`);
    }
    await fs.promises.mkdir(targetDir, { recursive: true });
    for (const tuple of tuples) {
      const relative = this.relativePathOf(name, tuple);
      if (!relative) continue;
      const file = path.join(targetDir, ...relative.split('/'));
      FileSystemUtils.assertPathWithin(targetDir, file);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const text =
        tuple.map?.artifact === 'metadata'
          ? metadataTextFromContent(tuple.content)
          : artifactTextFromContent(tuple.content);
      await fs.promises.writeFile(file, text, 'utf-8');
    }
  }

  // ---------------------------------------------------------------------------
  // Artefacts
  // ---------------------------------------------------------------------------

  async readArtifact(name: string, artifactPath: string): Promise<string | null> {
    const tuple = await this.liveArtefact(name, artifactPath);
    if (!tuple) return null;
    return artifactKeysFor(artifactPath).artifact === 'metadata'
      ? metadataTextFromContent(tuple.content)
      : artifactTextFromContent(tuple.content);
  }

  /**
   * Posts a version of an artefact. A first write posts a new tuple; a revision
   * posts a new tuple linked `supersedes` to the live one, so the live id
   * changes with every version. A caller that read a version passes its id as
   * `base`; a base that is no longer live is refused naming the live id unless
   * `force` is set. Metadata written by path goes through `writeMetadata`.
   */
  async writeArtifact(
    name: string,
    artifactPath: string,
    content: string,
    options: WriteArtifactOptions = {}
  ): Promise<WriteArtifactResult> {
    const keys = artifactKeysFor(artifactPath);
    const live = await this.liveArtefact(name, artifactPath);
    if (options.base !== undefined && !options.force && options.base !== live?.id) {
      throw new StaleArtifactError(name, artifactPath, options.base, live?.id ?? null);
    }

    if (keys.artifact === 'metadata') {
      const source = this.sourceOf(name, METADATA_FILENAME);
      await this.writeMetadata(name, parseChangeMetadataText(content, source, this.projectRoot));
      const written = await this.metadataTuple(name);
      return { id: written?.id ?? '' };
    }

    const metadata = await this.metadataTuple(name);
    const schema = metadata ? String(metadata.map?.schema ?? DEFAULT_SCHEMA) : DEFAULT_SCHEMA;
    const source = this.sourceOf(name, artifactPath);
    const summary = artifactSummary(name, artifactPath, content);
    const result = await this.session.post({
      kind: 'artefact',
      subjects: [this.changeSubject(name)],
      content: renderArtifactContent(summary, content),
      slug: `${name} ${keys.artifact}${keys.capability ? ` ${keys.capability}` : ''}`,
      tags: ['topic:openspec'],
      ...(live ? { links: [`supersedes:${live.id}`] } : {}),
      sdd: 'openspec',
      schema,
      artifact: keys.artifact,
      ...(keys.capability ? { capability: keys.capability } : {}),
      source,
    });
    return { id: result.tuple.id };
  }

  /** One entry per live delta spec tuple: the capability and the path the spec would have. */
  async listDeltaSpecs(name: string): Promise<DiscoveredSpec[]> {
    const tuples = await this.liveArtefacts(name, 'spec');
    return tuples
      .map((tuple) => ({
        id: String(tuple.map?.capability ?? ''),
        specFile: path.join(this.changesDir, name, 'specs', String(tuple.map?.capability ?? ''), 'spec.md'),
      }))
      .filter((spec) => spec.id !== '')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async listUnreadDeltas(name: string): Promise<DiscoveredSpec[]> {
    const deltas = await this.listDeltaSpecs(name);
    const specsDir = path.join(this.projectRoot, 'openspec', 'specs');
    return deltas.filter((delta) => !fs.existsSync(path.join(specsDir, delta.id, 'spec.md')));
  }

  /** True when the change holds anything besides its metadata, as the file store counts anything but dot files. */
  async hasAnyContent(name: string): Promise<boolean> {
    const tuples = await this.allLiveArtefacts(name);
    return tuples.some((tuple) => tuple.map?.artifact !== 'metadata');
  }

  /**
   * The change's task tuples by ordinal, completed ones included: a completed
   * task is retired, so the search asks for retired tuples too.
   */
  async listTasks(name: string): Promise<StoredTask[]> {
    const result = await this.client.search({
      subjects: [this.changeSubject(name), `repo:${this.board.repo}`],
      where: { kind: 'task' },
      retired: true,
      limit: 1000,
    });
    return result.items
      .map((tuple) => ({
        ordinal: Number(tuple.map?.task),
        id: tuple.id,
        description: tuple.content.split('\n')[0]?.trim() ?? '',
        done: tuple.state === 'retired',
      }))
      .filter((task) => Number.isFinite(task.ordinal))
      .sort((a, b) => a.ordinal - b.ordinal);
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

  async changeLastModified(name: string): Promise<Date | null> {
    const [newest] = await this.allLiveArtefacts(name);
    if (!newest?.created) return null;
    const date = new Date(String(newest.created));
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
