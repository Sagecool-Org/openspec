import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BoardClient, BoardError, BoardUnreachableError } from '../../../src/core/change-store/board-client.js';
import type { BoardConfig } from '../../../src/core/change-store/board-config.js';

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

describe('BoardClient', () => {
  let server: http.Server;
  let board: BoardConfig;
  let requests: RecordedRequest[];
  let respond: (verb: string, body: unknown) => { status: number; body: unknown };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const parsed = raw === '' ? null : JSON.parse(raw);
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body: parsed,
        });
        const verb = (req.url ?? '').replace('/api/', '');
        const reply = respond(verb, parsed);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    board = {
      url: `http://127.0.0.1:${port}`,
      repo: 'sagecool',
      configPath: '/repo/.agora.json',
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    requests = [];
    respond = (verb, body) => ({ status: 200, body: { verb, echoed: body } });
  });

  it('posts every verb to /api/<verb> as JSON with the bearer token', async () => {
    const client = new BoardClient({ board, token: 'tok-1' });

    await client.get('lusab-babad');
    await client.search({
      subjects: ['change:demo'],
      where: { kind: 'task' },
      retired: true,
    });
    await client.trail('lusab-babad');
    await client.take('lusab-babad', 5000);
    await client.take('lusab-babad');
    await client.complete('lusab-babad');
    await client.release('lusab-babad');
    await client.archive('lusab-babad');

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', '/api/get'],
      ['POST', '/api/search'],
      ['POST', '/api/trail'],
      ['POST', '/api/take'],
      ['POST', '/api/take'],
      ['POST', '/api/complete'],
      ['POST', '/api/release'],
      ['POST', '/api/archive'],
    ]);
    expect(requests.map((request) => request.body)).toEqual([
      { id: 'lusab-babad' },
      { subjects: ['change:demo'], where: { kind: 'task' }, retired: true },
      { id: 'lusab-babad' },
      { id: 'lusab-babad', lease_ms: 5000 },
      { id: 'lusab-babad' },
      { id: 'lusab-babad' },
      { id: 'lusab-babad' },
      { id: 'lusab-babad' },
    ]);
    for (const request of requests) {
      expect(request.authorization).toBe('Bearer tok-1');
      expect(request.contentType).toBe('application/json');
    }
  });

  it('mints the id of a post from its kind and slug, and keeps map keys', async () => {
    const client = new BoardClient({ board, token: 'tok-1' });
    const result = await client.post({
      kind: 'artefact',
      content: 'proposal body',
      subjects: ['change:demo'],
      slug: 'demo proposal',
      links: ['derives-from:lusab-babad'],
      tags: ['topic:openspec'],
      sdd: 'openspec',
      artifact: 'proposal',
    });
    const sent = requests[0].body as Record<string, unknown>;
    expect(sent.id).toMatch(/^[a-z]{5}-[a-z]{5}-artefact-demo-proposal$/);
    expect(sent).not.toHaveProperty('slug');
    expect(sent).toMatchObject({
      kind: 'artefact',
      content: 'proposal body',
      subjects: ['change:demo'],
      links: ['derives-from:lusab-babad'],
      tags: ['topic:openspec'],
      sdd: 'openspec',
      artifact: 'proposal',
    });
    expect(result).toEqual({ verb: 'post', echoed: sent });
  });

  it('supersedes by naming the live tuple as the id', async () => {
    const client = new BoardClient({ board, token: 'tok-1' });
    await client.supersede('lusab-babad-artefact-demo-proposal', {
      kind: 'artefact',
      content: 'revised',
      subjects: ['change:demo'],
    });
    expect(requests[0].url).toBe('/api/supersede');
    expect(requests[0].body).toEqual({
      id: 'lusab-babad-artefact-demo-proposal',
      kind: 'artefact',
      content: 'revised',
      subjects: ['change:demo'],
    });
  });

  it('reads the token from AGORA_TOKEN, else mints one once per client', async () => {
    const fromEnv = new BoardClient({
      board,
      env: { AGORA_TOKEN: ' env-token ' },
      mintToken: async () => 'unused',
    });
    await fromEnv.get('a');
    expect(requests[0].authorization).toBe('Bearer env-token');

    let minted = 0;
    const minting = new BoardClient({
      board,
      env: {},
      mintToken: async () => {
        minted += 1;
        return `minted-${minted}`;
      },
    });
    await minting.get('a');
    await minting.get('b');
    await minting.search();
    expect(minted).toBe(1);
    expect(requests.slice(1).map((request) => request.authorization)).toEqual([
      'Bearer minted-1',
      'Bearer minted-1',
      'Bearer minted-1',
    ]);
  });

  it('surfaces a board refusal with its status and code', async () => {
    respond = () => ({
      status: 409,
      body: { error: 'UNDECLARED', message: 'undeclared keys: sdd' },
    });
    const client = new BoardClient({ board, token: 'tok-1' });
    const failure = await client
      .post({
        kind: 'note',
        content: 'x',
        subjects: ['change:demo'],
        slug: 'x',
      })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(BoardError);
    expect(failure).not.toBeInstanceOf(BoardUnreachableError);
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('UNDECLARED');
    expect(failure.verb).toBe('post');
    expect(failure.message).toBe(`post failed on the board at ${board.url}: 409 undeclared keys: sdd`);
  });

  it('names the board when it does not answer, and never falls back', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const unreachable: BoardConfig = {
      url: `http://127.0.0.1:${closedPort}`,
      repo: 'sagecool',
      configPath: '/repo/.agora.json',
    };
    const client = new BoardClient({ board: unreachable, token: 'tok-1' });
    const failure = await client.search().catch((e) => e);
    expect(failure).toBeInstanceOf(BoardUnreachableError);
    expect(failure.message).toBe(`board at http://127.0.0.1:${closedPort} unreachable (ECONNREFUSED)`);
    expect(failure.board).toBe(unreachable);
    expect(requests).toEqual([]);
  });
});
