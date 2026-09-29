import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BoardClient, BoardError, type BoardTuple, type PostArgs, type TupleFields } from './board-client.js';

const execFileAsync = promisify(execFile);

/** The harness value this CLI stamps on every post it makes. */
export const OPENSPEC_HARNESS = 'openspec';

/** The concept every OpenSpec convention on the board hangs off. */
export const OPENSPEC_CONCEPT_SUBJECT = 'concept:openspec-on-agora';

// -----------------------------------------------------------------------------
// Repository context: what the working directory says at the moment of a post
// -----------------------------------------------------------------------------

export interface RepositoryContext {
  /** The repository's name on the board, from `.agora.json` or `AGORA_REPO`. */
  repo: string;
  /** The checked-out branch, or null when detached or outside git. */
  branch: string | null;
  /** The short commit the working directory is at, or null outside git. */
  baseCommit: string | null;
}

/** Runs git in a directory and returns trimmed stdout, or null when git fails. Injectable for tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export const runGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const out = stdout.trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
};

/**
 * Reads the context fresh: the branch is read from the working directory at
 * each post, not once at start, because a session that changes branch keeps
 * posting (design D3).
 */
export async function readRepositoryContext(
  projectRoot: string,
  repo: string,
  git: GitRunner = runGit
): Promise<RepositoryContext> {
  const [branch, baseCommit] = await Promise.all([
    git(['branch', '--show-current'], projectRoot),
    git(['rev-parse', '--short=12', 'HEAD'], projectRoot),
  ]);
  return { repo, branch, baseCommit };
}

/**
 * Stamps a post as every adapter does: `repo`, `branch`, `base_commit` and
 * `harness` as map keys, and `repo:`/`branch:` as subjects so the post lives
 * in the repository on the board.
 */
export function stampPost<T extends TupleFields>(args: T, context: RepositoryContext): T {
  const subjects = [...args.subjects, `repo:${context.repo}`];
  if (context.branch) subjects.push(`branch:${context.branch}`);
  return {
    ...args,
    subjects: Array.from(new Set(subjects)),
    repo: context.repo,
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.baseCommit ? { base_commit: context.baseCommit } : {}),
    harness: OPENSPEC_HARNESS,
  };
}

// -----------------------------------------------------------------------------
// Conventions: the notes this CLI declares before its first post
// -----------------------------------------------------------------------------

export interface ConventionNote {
  /** The id the note is posted under: its subject as words, so every poster re-posts the same one. */
  id: string;
  args: TupleFields;
  /**
   * A key shared with the other adapters (`harness`, `repo`, ...): posted when
   * absent and otherwise left as the board has it, so two adapters never take
   * turns rewriting one description. This CLI's own keys are superseded when
   * their description changes.
   */
  shared: boolean;
}

const OWN_STAMP = { harness: OPENSPEC_HARNESS, component: OPENSPEC_HARNESS };

function keyNote(
  name: string,
  shape: string,
  description: string,
  shared: boolean,
  describes?: string
): ConventionNote {
  return {
    id: `key-${name.replace(/[^a-z0-9]+/g, '-')}`,
    shared,
    args: {
      kind: 'note',
      subjects: [`key:${name}`],
      content: description,
      shape,
      ...OWN_STAMP,
      ...(describes ? { describes } : {}),
      ...(shared ? {} : { tags: ['topic:openspec'] }),
    },
  };
}

/**
 * Every convention the CLI relies on, in declaration order: the stamped keys
 * first (the notes themselves carry `harness`), then OpenSpec's own keys, the
 * `change` scheme and the concept note that ties them together. Descriptions
 * of OpenSpec's keys match the notes the board-backed-openspec proposal
 * posted, so declaring them where they already exist writes nothing.
 */
export function conventionNotes(): ConventionNote[] {
  return [
    keyNote(
      'harness',
      'string',
      'harness: the agent harness that posted: claude-code, codex, cli, web, trello, openspec; the adapter that stamps it declares it.',
      true,
      'posting'
    ),
    keyNote(
      'repo',
      'string',
      'repo: the repository the posting session was in; the adapter that stamps it declares it.',
      true,
      'posting'
    ),
    keyNote(
      'branch',
      'string',
      'branch: the branch the posting session was on; the adapter that stamps it declares it.',
      true,
      'posting'
    ),
    keyNote(
      'base_commit',
      'string',
      'base_commit: the commit the posting session started from; the adapter that stamps it declares it.',
      true,
      'posting'
    ),
    keyNote(
      'sdd',
      'string',
      'sdd: which spec-driven development structure a change tuple follows: openspec for an OpenSpec change. Lets one board hold changes of several layouts and be searched for one.',
      false
    ),
    keyNote(
      'schema',
      'string',
      "schema: the workflow schema a change follows within its sdd structure, as the tool names it: spec-driven for OpenSpec's default (proposal, specs, design, tasks).",
      false
    ),
    keyNote(
      'artifact',
      'string',
      'artifact: which artefact of its change a tuple is: metadata, proposal, design, spec (one delta spec, see capability) or tasks. On an artefact tuple only; a task tuple carries task instead.',
      false
    ),
    keyNote(
      'capability',
      'string',
      'capability: the capability path a delta spec targets, as it appears under openspec/specs/ (for example board-change-store). On artifact: spec tuples.',
      false
    ),
    keyNote(
      'task',
      'decimal',
      "task: the ordinal of a checklist item within its change's tasks artefact, counted from 1 in document order. On task tuples, which link derives-from the tasks artefact tuple.",
      false
    ),
    keyNote(
      'source',
      'string',
      "source: the repository path a tuple would have had on disk under the tool's file layout, so a pointer stays readable without the board: openspec/changes/<name>/proposal.md for an artefact, openspec/changes/<name>/tasks.md#3 for a task.",
      false
    ),
    keyNote(
      'task_ids',
      'string-list',
      "task_ids: on a tasks artefact tuple, the ids of the change's task tuples in document order; the newest tasks artefact's list is the change's current task list, so a task it no longer names is dropped whatever its state.",
      false
    ),
    {
      id: 'scheme-change',
      shared: false,
      args: {
        kind: 'note',
        subjects: ['scheme:change'],
        content:
          'change:<name> addresses one spec-driven change (an OpenSpec change here) and every tuple that belongs to it: its metadata, artefacts, tasks, claims, questions, findings, blockers and the decision that archives it.\n\n' +
          "Declared by the board-backed-openspec proposal (sagecool, 2026-09-17). A change's tuples also carry sdd, schema, artifact, capability, task and source keys, which say which structure the change follows and where each tuple would have lived on disk. A brief on change:<name> is the whole change.",
        tags: ['topic:openspec'],
        ...OWN_STAMP,
      },
    },
    {
      id: 'concept-openspec-on-agora',
      shared: false,
      args: {
        kind: 'note',
        subjects: [OPENSPEC_CONCEPT_SUBJECT, 'scheme:change'],
        content:
          'How an OpenSpec change is laid out on this board: one artefact tuple per file, one task tuple per checklist item, all on change:<name>, revisions supersede, archive retires.\n\n' +
          '- Every tuple of a change carries subject change:<name> and keys sdd: openspec, schema: <workflow schema>.\n' +
          '- artefact tuples: artifact is metadata, proposal, design, spec or tasks; source is the path the file would have under openspec/changes/<name>/; a spec tuple also carries capability. Content is the full markdown under a one-line summary. A revision is a new artefact tuple that supersedes the previous one; trail walks the history.\n' +
          '- task tuples: kind task, task is the ordinal from 1, source is openspec/changes/<name>/tasks.md#<ordinal>, links derives-from the tasks artefact tuple. Content is the item text. Taken while worked, completed at the commit that finishes it; a revised tasks artefact keeps kept items’ ids and retires dropped ones.\n' +
          "- claims: one on change:<name> per apply session, one on the task's paths per task.\n" +
          '- questions (status needs-human), findings and blockers raised while working a task link derives-from that task; a human answers a question with a decision linked answers.\n' +
          '- archive: a decision on change:<name> naming the commit that carried the merged specs; every other live tuple of the change is archived and stays readable by id.\n\n' +
          'Declared by the openspec CLI (the @sagecool/openspec fork), which re-declares any missing scheme or key note before it posts.',
        tags: ['topic:openspec'],
        ...OWN_STAMP,
      },
    },
  ];
}

export type DeclarationOutcome = 'posted' | 'superseded' | 'kept' | 'shape';

function isBoardCode(error: unknown, code: string): error is BoardError {
  return error instanceof BoardError && error.code === code;
}

/**
 * Declares one note as the adapters do: a post under its subject-derived id;
 * `ID_TAKEN` means a live note holds it, and then the same note is a
 * supersede, which the board ignores when nothing changed. A shared key that
 * is already declared is kept without a supersede.
 */
export async function declareNote(client: BoardClient, note: ConventionNote): Promise<DeclarationOutcome> {
  try {
    await client.post({ ...note.args, id: note.id });
    return 'posted';
  } catch (error: unknown) {
    if (isBoardCode(error, 'SHAPE')) return 'shape';
    if (!isBoardCode(error, 'ID_TAKEN')) throw error;
  }
  if (note.shared) return 'kept';
  try {
    const body = await client.supersede(note.id, note.args);
    const ignored = (body as { ignored?: unknown }).ignored;
    return Array.isArray(ignored) && ignored.length > 0 ? 'kept' : 'superseded';
  } catch (error: unknown) {
    if (isBoardCode(error, 'SHAPE')) return 'shape';
    throw error;
  }
}

/** Declares every convention, in order; returns what the board did with each, by id. */
export async function declareConventions(client: BoardClient): Promise<Record<string, DeclarationOutcome>> {
  const outcomes: Record<string, DeclarationOutcome> = {};
  for (const note of conventionNotes()) {
    outcomes[note.id] = await declareNote(client, note);
  }
  return outcomes;
}

// -----------------------------------------------------------------------------
// A posting session: declares once, stamps every post
// -----------------------------------------------------------------------------

export interface BoardSessionOptions {
  projectRoot: string;
  git?: GitRunner;
}

/**
 * What the board store posts through: the conventions are declared once per
 * session (one CLI invocation) before the first post, and every post and
 * supersede carries the repository context read at that moment.
 */
export class BoardSession {
  readonly client: BoardClient;
  private readonly projectRoot: string;
  private readonly git: GitRunner;
  private declaredPromise: Promise<Record<string, DeclarationOutcome>> | undefined;

  constructor(client: BoardClient, options: BoardSessionOptions) {
    this.client = client;
    this.projectRoot = options.projectRoot;
    this.git = options.git ?? runGit;
  }

  declared(): Promise<Record<string, DeclarationOutcome>> {
    if (!this.declaredPromise) {
      this.declaredPromise = declareConventions(this.client).catch((error: unknown) => {
        this.declaredPromise = undefined;
        throw error;
      });
    }
    return this.declaredPromise;
  }

  context(): Promise<RepositoryContext> {
    return readRepositoryContext(this.projectRoot, this.client.board.repo, this.git);
  }

  async post(args: PostArgs): Promise<{ tuple: BoardTuple; [key: string]: unknown }> {
    await this.declared();
    return this.client.post(stampPost(args, await this.context()));
  }

  async supersede(id: string, args: TupleFields): Promise<{ tuple: BoardTuple; [key: string]: unknown }> {
    await this.declared();
    return this.client.supersede(id, stampPost(args, await this.context()));
  }
}
