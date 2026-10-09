/**
 * The memo that turns "read and re-validate the whole index per lookup" into
 * "stat one inode per lookup".
 *
 * ## What is being memoized, and why only this
 *
 * `DeepSeekUploadIndex.get()` answers one lookup by calling `load()`, which
 * reads the whole index file and runs the parser over every record — so a
 * request carrying N retained images reads and validates the file N times
 * (`packages/llm/llm-deepseek/src/adapter.ts:95` → `images.ts:99` →
 * `request-files.ts:116` → `file-store.ts:200` → `upload-index.ts:149` → `:123`).
 * Measured on the published `0.2.1-alpha.1` bundle with 500 records, that read
 * and parse is **99.3%** of a lookup (read 13.5%, `JSON.parse` 31.7%, per-record
 * validation 54.1%, linear `.find` 0.7%).
 *
 * This module memoizes **`load()`'s result**, and nothing else. It deliberately
 * does not re-implement `get()`, the expiry rule, the lock, the atomic write or
 * the v3 file format: every one of those stays exactly the core implementation's
 * business, so the only thing a consumer can observe differently is *how often
 * the file is read*. That is also why the memo is correct for `commit()`,
 * `remove()` and `clear()` without knowing anything about them — measured, all
 * three build a new `records` array with `filter()` and assign it to a local, so
 * none of them mutates the array the memo holds.
 *
 * ## The one semantic difference, stated rather than implied
 *
 * Callers of the *unpatched* `load()` each receive a freshly parsed object.
 * Callers of the memoized one receive the object the first caller received, for
 * as long as the file's identity is unchanged. Nothing in the deepseek package
 * mutates what `load()` returns (the three writers above are the whole list, and
 * all three are read-only over it), so this is unobservable today — but it is a
 * real difference, it is the price of not paying the copy, and the README says
 * so under "Honest boundaries" rather than leaving a reader to discover it.
 *
 * ## Invalidation
 *
 * The file is written by `writeFileAtomic` (`@deepseek-ai/dsh-atomic-write`),
 * which writes a random-suffix sibling and renames it over the target. Measured,
 * two consecutive `commit()`s change the target's `ino` — so the identity key is
 * the inode, with size and `mtimeMs` as the cheap corroborating fields. The
 * inode is what makes a write that lands *inside the same millisecond* as a
 * preceding read still visible, which a modification-time-only key cannot
 * promise on every filesystem.
 *
 * A lookup stats the file before consulting the memo, and stats it again before
 * retaining a freshly parsed document: a read that raced a write is served
 * (correctly, from its own consistent read) but is **not** retained, so an older
 * generation can never end up installed after a newer write finished.
 *
 * @module @argszero/dsh-upload-index-cache/cache
 */

import { stat } from 'node:fs/promises'

/**
 * The filesystem identity of the index file, or the fact that it is not there.
 *
 * `present: false` is a cacheable state as much as any other: the parser treats a
 * missing file as an empty index, and a program that has never uploaded anything
 * looks this up on every request. It is invalidated the same way — by the next
 * `stat` disagreeing.
 */
export type IndexIdentity =
  | {
    readonly present: true
    /** Inode number: changed by `writeFileAtomic`'s rename on every local write. */
    readonly ino: number
    readonly size: number
    readonly mtimeMs: number
  }
  | { readonly present: false }

/** What a memoized index object has to look like. */
export interface IndexLike {
  /** Absolute index path, read on every call so a replaced instance is noticed. */
  readonly path: string
  load: LoadFunction
}

/** The `load()` shape being wrapped: called with the index instance as `this`. */
export type LoadFunction = (this: IndexLike) => Promise<unknown>

/** How the memo decides when a retained document may be reused. */
export interface MemoSettings {
  /**
   * Index files larger than this are read the ordinary way, every time. The
   * ceiling exists so a pathological index cannot make this plugin hold an
   * unbounded document resident; it measures serialized file size, not heap.
   */
  readonly maxBytes: number
  /**
   * Re-read a retained document once it is this old, even when the file's
   * identity still matches. `0` disables the age bound and leaves the identity
   * as the only trigger — the default, because the identity is the precise
   * signal and this one only exists for a filesystem whose metadata cannot be
   * trusted to change.
   */
  readonly maxAgeMs: number
}

/** Running counts for one mounted plugin. */
export interface MemoCounters {
  /** Calls that reached the wrapper. */
  lookups: number
  /** Calls answered from the retained document. */
  hits: number
  /** Calls that had to read and parse. */
  misses: number
  /** Calls skipped because the file is larger than `maxBytes`. */
  bypassed: number
  /** Reads that were served but not retained, because the file changed under them. */
  unstored: number
  /** Failures in this plugin's own bookkeeping, after which it falls open. */
  errors: number
}

interface Entry {
  readonly identity: IndexIdentity
  readonly value: unknown
  readonly storedAt: number
}

/** The identity of a file that is there, from a `stat` result. */
export function identityOf(info: {
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}): IndexIdentity {
  return { present: true, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * Read the identity of `path`, treating "no such file" as an identity of its own.
 * @param path - the index path.
 * @returns the identity, or `{ present: false }` when the file is absent.
 * @throws whatever `stat` throws that is not `ENOENT` — the caller falls open.
 */
export async function readIdentity(path: string): Promise<IndexIdentity> {
  try {
    return identityOf(await stat(path))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { present: false }
    throw error
  }
}

/** Whether two identities describe the same generation of the same file. */
export function sameIdentity(left: IndexIdentity, right: IndexIdentity): boolean {
  if (!left.present || !right.present) return left.present === right.present
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/** Accept a candidate object as an index this memo can patch. */
export function asIndexLike(value: unknown): IndexLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { path?: unknown; load?: unknown }
  if (typeof candidate.path !== 'string' || candidate.path === '') return undefined
  if (typeof candidate.load !== 'function') return undefined
  return value as IndexLike
}

/**
 * One memo, shared by every index this plugin covers.
 *
 * Entries are keyed by the index instance rather than kept in a single slot,
 * because two adapters in one process can hold two indexes at two paths and a
 * single slot would thrash between them. A `WeakMap` also means a discarded
 * adapter's document is collected with it, with no uninstall step of ours to get
 * wrong.
 */
export class LoadMemo {
  /** The counts reported by `snapshot()`. */
  readonly counters: MemoCounters = {
    lookups: 0, hits: 0, misses: 0, bypassed: 0, unstored: 0, errors: 0,
  }

  private entries = new WeakMap<object, Entry>()

  /**
   * @param settings - the size and age bounds.
   * @param now - the clock, injectable so the age bound is testable.
   * @param onError - called with anything this plugin's own bookkeeping threw.
   */
  constructor(
    private readonly settings: MemoSettings,
    private readonly now: () => number,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Forget every retained document. */
  reset(): void {
    // A WeakMap has no clear(); replacing it is the whole operation, and the old
    // one is collected once the instances it keys on are.
    this.entries = new WeakMap<object, Entry>()
  }

  /**
   * Whether a retained document has aged out.
   * @param storedAt - when it was retained.
   * @returns `true` when the age bound has been reached.
   */
  private aged(storedAt: number): boolean {
    if (this.settings.maxAgeMs <= 0) return false
    return this.now() - storedAt >= this.settings.maxAgeMs
  }

  /** Report a bookkeeping failure without letting the reporter itself escape. */
  private failed(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // A throwing diagnostic must not become the failure it was reporting.
    }
  }

  /**
   * Wrap one index's `load()`.
   *
   * Every path out of the returned function ends in a value the *unpatched*
   * method would also have produced: this is a memo, and a memo that changes an
   * answer is a bug wearing a performance improvement's clothes. Anything
   * uncertain — a `stat` that threw, a file past `maxBytes` — delegates straight
   * to the original.
   * @param original - the index's own `load`, captured before patching.
   * @returns the replacement, to be installed as the index's own `load`.
   */
  wrap(original: LoadFunction): LoadFunction {
    const memo = this
    return async function (this: IndexLike): Promise<unknown> {
      memo.counters.lookups += 1
      let before: IndexIdentity
      try {
        before = await readIdentity(this.path)
      } catch (error: unknown) {
        memo.counters.errors += 1
        memo.failed(error)
        return original.call(this)
      }
      if (memo.settings.maxBytes > 0 && before.present && before.size > memo.settings.maxBytes) {
        memo.counters.bypassed += 1
        return original.call(this)
      }
      const retained = memo.entries.get(this)
      if (retained !== undefined && sameIdentity(retained.identity, before) && !memo.aged(retained.storedAt)) {
        memo.counters.hits += 1
        return retained.value
      }
      memo.counters.misses += 1
      const value = await original.call(this)
      let after: IndexIdentity
      try {
        after = await readIdentity(this.path)
      } catch (error: unknown) {
        memo.counters.errors += 1
        memo.failed(error)
        memo.counters.unstored += 1
        return value
      }
      if (sameIdentity(before, after)) {
        memo.entries.set(this, { identity: after, value, storedAt: memo.now() })
      } else {
        // The file changed while it was being read. The value above is a
        // consistent snapshot of *some* generation, so it is returned; what must
        // not happen is retaining it under the newer generation's identity.
        memo.counters.unstored += 1
      }
      return value
    }
  }
}
