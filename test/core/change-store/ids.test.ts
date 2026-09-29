import { describe, it, expect } from 'vitest';
import {
  describingId,
  generateId,
  idForPost,
  idSegment,
  isValidId,
  proquint,
  proquintPair,
} from '../../../src/core/change-store/ids.js';

describe('tuple ids', () => {
  it('encodes sixteen bits as a pronounceable word and thirty-two as a pair', () => {
    expect(proquint(0)).toBe('babab');
    expect(proquint(0xffff)).toBe('zuzuz');
    expect(proquintPair(0x0000ffff)).toBe('babab-zuzuz');
    expect(proquintPair(0xffffffff)).toBe('zuzuz-zuzuz');
  });

  it('folds text into an id segment', () => {
    expect(idSegment('Apply the Breadcrumb anatomy!')).toBe('apply-the-breadcrumb-anatomy');
    expect(idSegment('  ---  ')).toBeNull();
    expect(idSegment('Café crème')).toBe('cafe-creme');
    expect(idSegment('a'.repeat(70))).toBe('a'.repeat(64));
    // Cut to the limit, then the last segment goes even when the cut fell on a boundary, as the gem does.
    expect(idSegment(`${'word-'.repeat(15)}tail`)).toBe('word-'.repeat(11) + 'word');
  });

  it('mints a pair, the kind and the slug for a post', () => {
    expect(generateId('task', 'Board backed openspec task 1.1', () => 0x0000ffff)).toBe(
      'babab-zuzuz-task-board-backed-openspec-task-1-1'
    );
    expect(() => generateId('task', '!!!')).toThrow('an id needs a slug');
  });

  it('names a note about the board after its subject', () => {
    expect(describingId('key:base_commit')).toBe('key-base-commit');
    expect(describingId('kind:claim')).toBe('kind-claim');
  });

  it('picks the id convention for a post', () => {
    expect(idForPost({ id: 'given-id', kind: 'finding' })).toBe('given-id');
    expect(idForPost({ kind: 'note', subjects: ['key:sdd'] })).toBe('key-sdd');
    expect(idForPost({ kind: 'artefact', slug: 'proposal', subjects: ['change:x'] })).toMatch(
      /^[bdfghjklmnprstvz][aiou][bdfghjklmnprstvz][aiou][bdfghjklmnprstvz]-[a-z]{5}-artefact-proposal$/
    );
    expect(() => idForPost({ kind: 'artefact', subjects: ['change:x'] })).toThrow('a post needs an id or a slug');
  });

  it('validates the form of an id', () => {
    expect(isValidId('lusab-babad-decision-lease-lapse-sweeper')).toBe(true);
    expect(isValidId('key-sdd')).toBe(true);
    expect(isValidId('Has Caps')).toBe(false);
    expect(isValidId('-leading')).toBe(false);
    expect(isValidId(42)).toBe(false);
  });
});
