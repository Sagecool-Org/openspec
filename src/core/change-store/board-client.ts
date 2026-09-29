import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BoardConfig } from './board-config.js';
import { idForPost } from './ids.js';

const execFileAsync = promisify(execFile);

/** One tuple as the board returns it: the poster's fields plus the envelope. */
export interface BoardTuple {
  id: string;
  kind: string;
  content: string;
  subjects: string[];
  map?: Record<string, string | string[]>;
  links?: string[];
  author?: string;
  author_name?: string;
  run?: string;
  created?: string;
  expires?: string;
  state?: string;
  [key: string]: unknown;
}

/**
 * The fields of a tuple as a poster supplies them; everything not named here
 * is a map key. (Spelled out rather than derived with `Omit`, which loses the
 * named fields on a type with an index signature.)
 */
export interface TupleFields {
  kind: string;
  content: string;
  subjects: string[];
  /** `rel:id` edges, written with the post and never after it. */
  links?: string[];
  tags?: string[];
  status?: string;
  lease_ms?: number;
  [mapKey: string]: unknown;
}

/** A post: the tuple's fields plus how its id is chosen. */
export interface PostArgs extends TupleFields {
  /** A few words naming the tuple; part of the minted id, not a key. */
  slug?: string;
  /** An explicit id; minted from kind and slug when absent. */
  id?: string;
}

export interface SearchArgs {
  subjects?: string[];
  where?: Record<string, unknown>;
  not?: Record<string, unknown>;
  since?: string;
  before?: string;
  text?: string;
  ready?: boolean;
  after?: string;
  template?: unknown;
  inbound?: string;
  retired?: boolean;
  limit?: number;
  offset?: number;
}

export class BoardError extends Error {
  constructor(
    message: string,
    public readonly board: BoardConfig,
    public readonly verb: string,
    public readonly status?: number,
    /** The board's error code when it gave one: `UNDECLARED`, `ID_TAKEN`, `VALIDATION`, ... */
    public readonly code?: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'BoardError';
  }
}

/** The board did not answer: refused, timed out, or the name did not resolve. Never a fallback to files. */
export class BoardUnreachableError extends BoardError {
  constructor(board: BoardConfig, verb: string, cause: unknown) {
    super(`board at ${board.url} unreachable (${describeCause(cause)})`, board, verb);
    this.name = 'BoardUnreachableError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as Error & { cause?: unknown }).cause;
    const code = (inner as { code?: string } | undefined)?.code ?? (cause as { code?: string }).code;
    return code ?? cause.name;
  }
  return String(cause);
}

export interface BoardClientOptions {
  board: BoardConfig;
  /** The token to send; `AGORA_TOKEN` by default. */
  token?: string;
  /** Mints a token when none was given: one `agora token` run per client. */
  mintToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Per-request read timeout. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs the Ruby adapter once: it holds the workstation key and prints a fresh token. */
export async function mintTokenWithAgoraCli(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('agora', ['token'], {
      encoding: 'utf-8',
      timeout: 20_000,
    }));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot mint a board token: \`agora token\` failed (${detail}). Enrol this workstation with the agora CLI or set AGORA_TOKEN.`
    );
  }
  const token = stdout.trim();
  if (token === '') {
    throw new Error('cannot mint a board token: `agora token` printed nothing');
  }
  return token;
}

/**
 * The board's verbs over HTTP: `POST <url>/api/<verb>` with a JSON body and a
 * bearer token, exactly as the Ruby adapter calls them. The token comes from
 * `AGORA_TOKEN` when set, otherwise from one `agora token` run per client, so
 * a CLI invocation mints at most once.
 */
export class BoardClient {
  readonly board: BoardConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private tokenPromise: Promise<string> | undefined;
  private readonly mintToken: () => Promise<string>;

  constructor(options: BoardClientOptions) {
    this.board = options.board;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.mintToken = options.mintToken ?? mintTokenWithAgoraCli;
    const env = options.env ?? process.env;
    const given = options.token ?? env.AGORA_TOKEN?.trim();
    if (given) {
      this.tokenPromise = Promise.resolve(given);
    }
  }

  private token(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.mintToken().catch((error: unknown) => {
        this.tokenPromise = undefined;
        throw error;
      });
    }
    return this.tokenPromise;
  }

  /** Any verb. Resolves with the board's body on 200; throws `BoardError` otherwise. */
  async call<T = unknown>(verb: string, args: Record<string, unknown> = {}): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.board.url}/api/${verb}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      throw new BoardUnreachableError(this.board, verb, error);
    }

    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON: keep the text for the message.
    }
    if (response.status !== 200) {
      const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
      const code = typeof record?.error === 'string' ? record.error : undefined;
      const detail = typeof record?.message === 'string' ? record.message : (code ?? String(text));
      throw new BoardError(
        `${verb} failed on the board at ${this.board.url}: ${response.status} ${detail}`,
        this.board,
        verb,
        response.status,
        code,
        body
      );
    }
    return body as T;
  }

  /** Posts a tuple, minting its id from kind and slug unless one is given. Returns the board's envelope. */
  async post(args: PostArgs): Promise<{ tuple: BoardTuple; [key: string]: unknown }> {
    const { slug, ...rest } = args;
    const id = idForPost({
      id: args.id,
      kind: args.kind,
      slug,
      subjects: args.subjects,
    });
    return this.call('post', { ...rest, id });
  }

  /** Posts a new version of a live tuple: `id` is the tuple it replaces, and the board links it `supersedes`. */
  async supersede(id: string, args: TupleFields): Promise<{ tuple: BoardTuple; [key: string]: unknown }> {
    return this.call('supersede', { ...args, id });
  }

  async get(id: string): Promise<{ tuple: BoardTuple; [key: string]: unknown }> {
    return this.call('get', { id });
  }

  async search(args: SearchArgs = {}): Promise<{ tuples: BoardTuple[]; [key: string]: unknown }> {
    return this.call('search', args as Record<string, unknown>);
  }

  async trail(id: string): Promise<unknown> {
    return this.call('trail', { id });
  }

  async take(id: string, leaseMs?: number): Promise<unknown> {
    return this.call('take', leaseMs === undefined ? { id } : { id, lease_ms: leaseMs });
  }

  async complete(id: string): Promise<unknown> {
    return this.call('complete', { id });
  }

  async release(id: string): Promise<unknown> {
    return this.call('release', { id });
  }

  async archive(id: string): Promise<unknown> {
    return this.call('archive', { id });
  }
}
