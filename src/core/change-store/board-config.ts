import fs from 'node:fs';
import path from 'node:path';

export const BOARD_CONFIG_FILENAME = '.agora.json';

/** The board a repository declares: `.agora.json` at its root, overridable by `AGORA_URL` and `AGORA_REPO`. */
export interface BoardConfig {
  /** The board's base URL, `POST <url>/api/<verb>`. */
  url: string;
  /** The repository's name on the board: the `repo:<name>` subject every post carries. */
  repo: string;
  /** The file that declared the board, for messages. */
  configPath: string;
}

export class BoardConfigError extends Error {
  constructor(
    message: string,
    public readonly configPath: string
  ) {
    super(message);
    this.name = 'BoardConfigError';
  }
}

function optionalString(value: unknown, key: string, configPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BoardConfigError(`${configPath}: "${key}" must be a non-empty string`, configPath);
  }
  return value.trim();
}

/**
 * Reads the board a root declares, or null when it declares none. A file that
 * exists but cannot be used is an error, never a silent fallback to files: the
 * repository asked for a board, so the command must not read or write
 * `openspec/changes/` in its place.
 */
export function findBoardConfig(rootPath: string, env: NodeJS.ProcessEnv = process.env): BoardConfig | null {
  const configPath = path.join(rootPath, BOARD_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw new BoardConfigError(
      `${configPath}: cannot be read (${error instanceof Error ? error.message : String(error)})`,
      configPath
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new BoardConfigError(
      `${configPath}: is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      configPath
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BoardConfigError(`${configPath}: must be a JSON object with "repo" and "url"`, configPath);
  }
  const record = parsed as Record<string, unknown>;

  const url = optionalString(env.AGORA_URL, 'AGORA_URL', configPath) ?? optionalString(record.url, 'url', configPath);
  const repo =
    optionalString(env.AGORA_REPO, 'AGORA_REPO', configPath) ?? optionalString(record.repo, 'repo', configPath);
  if (!url) {
    throw new BoardConfigError(`${configPath}: names no board; set "url" in the file or AGORA_URL`, configPath);
  }
  if (!repo) {
    throw new BoardConfigError(`${configPath}: names no repository; set "repo" in the file or AGORA_REPO`, configPath);
  }
  return { url: url.replace(/\/+$/, ''), repo, configPath };
}
