import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BoardClient } from '../../../src/core/change-store/board-client.js';
import type { BoardConfig } from '../../../src/core/change-store/board-config.js';
import {
  BoardSession,
  conventionNotes,
  declareConventions,
  stampPost,
  type GitRunner,
} from '../../../src/core/change-store/board-conventions.js';

interface LiveTuple {
  args: Record<string, unknown>;
  versions: number;
}

/**
 * A board reduced to what declaration exercises: `post` refuses an id a live
 * tuple holds with ID_TAKEN, `supersede` replaces a live tuple and reports the
 * fields it ignored when nothing changed. Exactly the two answers the
 * adapters' declare loop keys on.
 */
class StubBoard {
  live = new Map<string, LiveTuple>();
  calls: Array<{ verb: string; body: Record<string, unknown> }> = [];

  handle(verb: string, body: Record<string, unknown>): { status: number; body: unknown } {
    this.calls.push({ verb, body });
    const id = String(body.id);
    if (verb === 'post') {
      if (this.live.has(id))
        return {
          status: 409,
          body: { error: 'ID_TAKEN', message: `${id} is live` },
        };
      this.live.set(id, { args: body, versions: 1 });
      return { status: 200, body: { tuple: { ...body } } };
    }
    if (verb === 'supersede') {
      const current = this.live.get(id);
      if (!current)
        return {
          status: 404,
          body: { error: 'NOT_FOUND', message: `${id} is not live` },
        };
      const unchanged = JSON.stringify(current.args) === JSON.stringify(body);
      if (unchanged)
        return {
          status: 200,
          body: { tuple: { ...body }, ignored: ['content'] },
        };
      this.live.set(id, { args: body, versions: current.versions + 1 });
      return { status: 200, body: { tuple: { ...body } } };
    }
    return {
      status: 400,
      body: { error: 'VALIDATION', message: `unknown verb ${verb}` },
    };
  }
}

describe('board conventions', () => {
  let server: http.Server;
  let board: BoardConfig;
  let stub: StubBoard;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const verb = (req.url ?? '').replace('/api/', '');
        const reply = stub.handle(verb, JSON.parse(raw));
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
    stub = new StubBoard();
  });

  it('declares each convention once across two invocations', async () => {
    const notes = conventionNotes();
    const first = await declareConventions(new BoardClient({ board, token: 't' }));
    expect(Object.values(first)).toEqual(notes.map(() => 'posted'));

    const second = await declareConventions(new BoardClient({ board, token: 't' }));
    expect(Object.values(second)).toEqual(notes.map(() => 'kept'));

    expect([...stub.live.keys()]).toEqual(notes.map((note) => note.id));
    expect([...stub.live.values()].every((tuple) => tuple.versions === 1)).toBe(true);
    // A shared key is never superseded; this CLI's own notes are, and the board ignored them unchanged.
    const supersedes = stub.calls.filter((call) => call.verb === 'supersede').map((call) => call.body.id);
    expect(supersedes).toEqual(notes.filter((note) => !note.shared).map((note) => note.id));
  });

  it('declares the stamped keys, the OpenSpec keys, the change scheme and the concept', () => {
    const notes = conventionNotes();
    expect(notes.map((note) => note.id)).toEqual([
      'key-harness',
      'key-repo',
      'key-branch',
      'key-base-commit',
      'key-sdd',
      'key-schema',
      'key-artifact',
      'key-capability',
      'key-task',
      'key-source',
      'key-task-ids',
      'scheme-change',
      'concept-openspec-on-agora',
    ]);
    expect(notes.find((note) => note.id === 'key-task')?.args).toMatchObject({
      kind: 'note',
      subjects: ['key:task'],
      shape: 'decimal',
      harness: 'openspec',
      component: 'openspec',
      tags: ['topic:openspec'],
    });
    expect(notes.find((note) => note.id === 'key-harness')?.args).toMatchObject({
      subjects: ['key:harness'],
      shape: 'string',
      describes: 'posting',
    });
    expect(notes.find((note) => note.id === 'key-harness')?.shared).toBe(true);
    expect(notes.find((note) => note.id === 'concept-openspec-on-agora')?.args.subjects).toEqual([
      'concept:openspec-on-agora',
      'scheme:change',
    ]);
  });

  it('re-declares a changed own description and leaves a shared key as the board has it', async () => {
    stub.live.set('key-sdd', {
      args: { id: 'key-sdd', kind: 'note', content: 'old wording' },
      versions: 1,
    });
    stub.live.set('key-harness', {
      args: {
        id: 'key-harness',
        kind: 'note',
        content: 'someone else wrote this',
      },
      versions: 1,
    });
    const outcomes = await declareConventions(new BoardClient({ board, token: 't' }));
    expect(outcomes['key-sdd']).toBe('superseded');
    expect(stub.live.get('key-sdd')?.versions).toBe(2);
    expect(outcomes['key-harness']).toBe('kept');
    expect(stub.live.get('key-harness')?.args.content).toBe('someone else wrote this');
  });

  it('stamps repo, branch, base_commit and harness on a post and reads the branch each time', async () => {
    let branch = 'claude/one';
    const git: GitRunner = async (args) => {
      if (args[0] === 'branch') return branch;
      if (args[0] === 'rev-parse') return 'abcdef123456';
      return null;
    };
    const session = new BoardSession(new BoardClient({ board, token: 't' }), {
      projectRoot: '/repo',
      git,
    });

    await session.post({
      kind: 'artefact',
      content: 'body',
      subjects: ['change:demo'],
      slug: 'demo proposal',
      sdd: 'openspec',
    });
    branch = 'claude/two';
    await session.post({
      kind: 'task',
      content: '1.1 Do it',
      subjects: ['change:demo'],
      slug: 'demo task 1',
      task: 1,
    });

    const posts = stub.calls.filter(
      (call) => call.verb === 'post' && !String(call.body.id).match(/^(key|scheme|concept)-/)
    );
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({
      kind: 'artefact',
      subjects: ['change:demo', 'repo:sagecool', 'branch:claude/one'],
      repo: 'sagecool',
      branch: 'claude/one',
      base_commit: 'abcdef123456',
      harness: 'openspec',
      sdd: 'openspec',
    });
    expect(posts[0].body).not.toHaveProperty('slug');
    expect(posts[1].body).toMatchObject({
      subjects: ['change:demo', 'repo:sagecool', 'branch:claude/two'],
      branch: 'claude/two',
      task: 1,
    });

    // Conventions were declared once, before the first post.
    const declared = stub.calls.filter((call) => String(call.body.id).match(/^(key|scheme|concept)-/));
    expect(declared).toHaveLength(conventionNotes().length);
    expect(stub.calls[0].body.id).toBe('key-harness');
  });

  it('omits branch and base_commit outside git', () => {
    const stamped = stampPost(
      {
        kind: 'finding',
        content: 'x',
        subjects: ['change:demo', 'repo:sagecool'],
      },
      { repo: 'sagecool', branch: null, baseCommit: null }
    );
    expect(stamped).toEqual({
      kind: 'finding',
      content: 'x',
      subjects: ['change:demo', 'repo:sagecool'],
      repo: 'sagecool',
      harness: 'openspec',
    });
  });
});
