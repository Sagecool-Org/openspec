import { randomInt } from 'node:crypto';

/**
 * Tuple ids as the Agora adapters mint them. The board reads nothing from an
 * id: it is any string of lower-case words, digits and hyphens, unique among
 * live tuples, and the poster's to choose. This client mints
 * `<proquint pair>-<kind>-<slug>` so an id quoted in a commit message reads
 * without the board, and a note describing the board (`key:x`, `kind:x`) takes
 * its subject as its id, a namespace a proquint pair cannot collide with.
 * Ported from the Ruby adapter's `Agora::Support::Ids`.
 */

const CONSONANTS = 'bdfghjklmnprstvz';
const VOWELS = 'aiou';
const SEGMENT = '[a-z0-9]+';
const FORM = new RegExp(`^${SEGMENT}(-${SEGMENT})*$`);
const MAX = 128;
const SLUG_MAX = 64;

/** A pronounceable five-letter word for sixteen bits. */
export function proquint(n: number): string {
  return [
    CONSONANTS[(n >> 12) & 15],
    VOWELS[(n >> 10) & 3],
    CONSONANTS[(n >> 6) & 15],
    VOWELS[(n >> 4) & 3],
    CONSONANTS[n & 15],
  ].join('');
}

/** Two proquint words for thirty-two bits. */
export function proquintPair(n: number): string {
  return `${proquint((n >>> 16) & 0xffff)}-${proquint(n & 0xffff)}`;
}

/**
 * Text as an id segment: ASCII folded, lower-cased, runs of anything else
 * become one hyphen, cut to the slug limit on a word boundary. Null when
 * nothing is left.
 */
export function idSegment(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let s = text
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX).replace(/-[^-]*$/, '');
  }
  return s === '' ? null : s;
}

/** The id for a post: thirty-two random bits, the kind, and the slug the poster gave, which is required. */
export function generateId(kind: string, slug: string, random: () => number = () => randomInt(0, 2 ** 32)): string {
  const label = idSegment(slug);
  if (label === null) {
    throw new Error('an id needs a slug: a few words naming the tuple');
  }
  return [proquintPair(random()), idSegment(kind), label].filter((part) => part !== null).join('-');
}

/** The id of a note on a kernel subject (`key:x`, `kind:x`, `rel:x`, `scheme:x`): the subject itself, as words. */
export function describingId(subject: string): string {
  const segment = idSegment(subject);
  if (segment === null) {
    throw new Error(`cannot derive an id from subject ${JSON.stringify(subject)}`);
  }
  return segment;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX && FORM.test(id);
}

const KERNEL_SUBJECT = /^(key|kind|rel|scheme):/;

/**
 * The id a tuple is posted under, the adapters' shared convention: an
 * explicit id wins; a note on a kernel subject takes that subject; anything
 * else gets a fresh pair with its kind and slug.
 */
export function idForPost(args: { id?: string; kind: string; slug?: string; subjects?: string[] }): string {
  if (args.id) return args.id;
  const kernel = (args.subjects ?? []).find((subject) => KERNEL_SUBJECT.test(subject));
  if (args.kind === 'note' && kernel) return describingId(kernel);
  if (!args.slug) {
    throw new Error('a post needs an id or a slug: a few words naming the tuple');
  }
  return generateId(args.kind, args.slug);
}
