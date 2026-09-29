import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BoardConfig } from '../../src/core/change-store/board-config.js';

/**
 * An in-memory Agora board with the behaviour the change store relies on:
 * ids unique among live tuples (`ID_TAKEN`), a post linked `supersedes:<id>`
 * retiring the old version from default search, `supersede` as a same-id
 * new version that reports what it ignored, search by subject template
 * (every scheme named must match; an address covers its descendants and is
 * found by its ancestors), `where` on kind and map keys, `retired: true` to
 * include completed and archived tuples, and leases for take, complete and
 * release. Nothing here is the board's code; it is the contract the tests
 * hold the store to.
 */

export type StubState = 'open' | 'superseded' | 'retired';

export interface StubTuple {
  id: string;
  kind: string;
  content: string;
  subjects: string[];
  links: string[];
  map: Record<string, unknown>;
  state: StubState;
  created: string;
  /** When the board would retire the tuple: 90 days for artefacts and notes, 30 for the rest, as the kinds are seeded. */
  expires: string;
  lease?: string;
  completed?: boolean;
  archived?: boolean;
}

export interface StubCall {
  verb: string;
  body: Record<string, unknown>;
}

const RESERVED = new Set(['id', 'kind', 'content', 'subjects', 'links', 'lease_ms']);

function splitSubject(subject: string): { scheme: string; segments: string[] } {
  const colon = subject.indexOf(':');
  const scheme = colon === -1 ? 'path' : subject.slice(0, colon);
  const rest = colon === -1 ? subject : subject.slice(colon + 1);
  return {
    scheme,
    segments: rest.split('/').filter((segment) => segment !== ''),
  };
}

function overlaps(a: string, b: string): boolean {
  const x = splitSubject(a);
  const y = splitSubject(b);
  if (x.scheme !== y.scheme) return false;
  const shorter = x.segments.length <= y.segments.length ? x.segments : y.segments;
  const longer = shorter === x.segments ? y.segments : x.segments;
  return shorter.every((segment, index) => longer[index] === segment);
}

export class StubBoard {
  readonly tuples = new Map<string, StubTuple>();
  readonly calls: StubCall[] = [];
  readonly owner = 'stub-owner';
  private tick = 0;

  private now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 8, 29, 0, 0, this.tick)).toISOString();
  }

  private answer(status: number, body: unknown): { status: number; body: unknown } {
    return { status, body };
  }

  private refuse(status: number, error: string, message: string): { status: number; body: unknown } {
    return this.answer(status, { error, message });
  }

  live(): StubTuple[] {
    return [...this.tuples.values()].filter((tuple) => tuple.state === 'open');
  }

  private build(body: Record<string, unknown>, id: string): StubTuple {
    const map: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!RESERVED.has(key) && value !== undefined) map[key] = value;
    }
    return {
      id,
      kind: String(body.kind),
      content: String(body.content ?? ''),
      subjects: Array.isArray(body.subjects) ? body.subjects.map(String) : [],
      links: Array.isArray(body.links) ? body.links.map(String) : [],
      map,
      state: 'open',
      created: this.now(),
      expires: this.expiry(String(body.kind)),
    };
  }

  private expiry(kind: string): string {
    const days = kind === 'artefact' || kind === 'note' || kind === 'decision' ? 90 : 30;
    return new Date(Date.UTC(2026, 8, 29 + days, 0, 0, this.tick)).toISOString();
  }

  handle(verb: string, body: Record<string, unknown>): { status: number; body: unknown } {
    this.calls.push({ verb, body });
    const id = typeof body.id === 'string' ? body.id : undefined;

    switch (verb) {
      case 'post': {
        if (!id) return this.refuse(400, 'VALIDATION', 'a post needs an id');
        const existing = this.tuples.get(id);
        if (existing && existing.state === 'open') return this.refuse(409, 'ID_TAKEN', `${id} is live`);
        const tuple = this.build(body, id);
        for (const link of tuple.links) {
          const [rel, target] = [link.slice(0, link.indexOf(':')), link.slice(link.indexOf(':') + 1)];
          if (rel === 'supersedes') {
            const previous = this.tuples.get(target);
            if (!previous) return this.refuse(404, 'NOT_FOUND', `${target} is not on the board`);
            previous.state = 'superseded';
          }
        }
        this.tuples.set(id, tuple);
        return this.answer(200, { tuple: this.render(tuple) });
      }
      case 'supersede': {
        if (!id) return this.refuse(400, 'VALIDATION', 'a supersede needs the id of the live tuple it replaces');
        const current = this.tuples.get(id);
        if (!current || current.state !== 'open') return this.refuse(404, 'NOT_FOUND', `${id} is not live`);
        const next = this.build(body, id);
        const unchanged =
          next.content === current.content &&
          JSON.stringify(next.map) === JSON.stringify(current.map) &&
          JSON.stringify(next.subjects) === JSON.stringify(current.subjects);
        if (unchanged)
          return this.answer(200, {
            tuple: this.render(current),
            ignored: ['content'],
          });
        this.tuples.set(id, next);
        return this.answer(200, { tuple: this.render(next) });
      }
      case 'get': {
        const tuple = id ? this.tuples.get(id) : undefined;
        if (!tuple) return this.refuse(404, 'NOT_FOUND', `${id} is not on the board`);
        return this.answer(200, { tuple: this.render(tuple) });
      }
      case 'search': {
        const subjects = Array.isArray(body.subjects) ? body.subjects.map(String) : [];
        const where = (body.where ?? {}) as Record<string, unknown>;
        const includeRetired = body.retired === true;
        const includeSuperseded = body.superseded === true;
        const items = [...this.tuples.values()]
          .filter((tuple) => {
            if (tuple.state === 'superseded' && !includeSuperseded) return false;
            if (tuple.state === 'retired' && !includeRetired) return false;
            const schemes = new Set(subjects.map((subject) => splitSubject(subject).scheme));
            for (const scheme of schemes) {
              const wanted = subjects.filter((subject) => splitSubject(subject).scheme === scheme);
              if (!tuple.subjects.some((have) => wanted.some((want) => overlaps(have, want)))) return false;
            }
            for (const [key, value] of Object.entries(where)) {
              const actual = key === 'kind' ? tuple.kind : tuple.map[key];
              if (Array.isArray(actual)) {
                const wanted = Array.isArray(value) ? value : [value];
                if (!wanted.every((entry) => actual.includes(entry))) return false;
              } else if (actual !== value) {
                return false;
              }
            }
            return true;
          })
          .sort((a, b) => (a.created < b.created ? 1 : -1))
          .map((tuple) => this.render(tuple));
        return this.answer(200, { items, total: items.length, cursor: null });
      }
      case 'trail': {
        const chain: StubTuple[] = [];
        let current = id ? this.tuples.get(id) : undefined;
        while (current) {
          chain.push(current);
          const link = current.links.find((entry) => entry.startsWith('supersedes:'));
          current = link ? this.tuples.get(link.slice('supersedes:'.length)) : undefined;
        }
        return this.answer(200, {
          items: chain.map((tuple) => this.render(tuple)),
        });
      }
      case 'take': {
        const tuple = id ? this.tuples.get(id) : undefined;
        if (!tuple || tuple.state !== 'open') return this.refuse(404, 'NOT_FOUND', `${id} is not live`);
        if (tuple.lease && tuple.lease !== this.owner) return this.refuse(409, 'TAKEN', `${id} is held`);
        tuple.lease = this.owner;
        return this.answer(200, { tuple: this.render(tuple) });
      }
      case 'release': {
        const tuple = id ? this.tuples.get(id) : undefined;
        if (!tuple) return this.refuse(404, 'NOT_FOUND', `${id} is not on the board`);
        delete tuple.lease;
        return this.answer(200, { tuple: this.render(tuple) });
      }
      case 'complete': {
        const tuple = id ? this.tuples.get(id) : undefined;
        if (!tuple || tuple.state !== 'open') return this.refuse(404, 'NOT_FOUND', `${id} is not live`);
        delete tuple.lease;
        tuple.state = 'retired';
        tuple.completed = true;
        return this.answer(200, { tuple: this.render(tuple) });
      }
      case 'archive': {
        const tuple = id ? this.tuples.get(id) : undefined;
        if (!tuple || tuple.state !== 'open') return this.refuse(404, 'NOT_FOUND', `${id} is not live`);
        delete tuple.lease;
        tuple.state = 'retired';
        tuple.archived = true;
        return this.answer(200, { tuple: this.render(tuple) });
      }
      default:
        return this.refuse(400, 'VALIDATION', `unknown verb ${verb}`);
    }
  }

  render(tuple: StubTuple): Record<string, unknown> {
    return {
      id: tuple.id,
      kind: tuple.kind,
      content: tuple.content,
      subjects: tuple.subjects,
      links: tuple.links,
      map: tuple.map,
      state: tuple.state === 'open' && tuple.lease ? 'taken' : tuple.state,
      created: tuple.created,
      expires: tuple.expires,
      author_name: 'stub',
      run: 'stub-run',
      ...(tuple.lease ? { lease: { owner: tuple.lease } } : {}),
    };
  }
}

export interface RunningStubBoard {
  stub: StubBoard;
  board: BoardConfig;
  url: string;
  close(): Promise<void>;
}

export async function startStubBoard(repo = 'sagecool'): Promise<RunningStubBoard> {
  const stub = new StubBoard();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const verb = (req.url ?? '').replace(/^\/api\//, '');
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'VALIDATION', message: 'body is not JSON' }));
        return;
      }
      const reply = stub.handle(verb, body);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    stub,
    url,
    board: { url, repo, configPath: '/repo/.agora.json' },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
