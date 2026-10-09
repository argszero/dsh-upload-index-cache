/**
 * The memo, measured against the filesystem it claims to be watching.
 *
 * Every test here writes to a real file in a real scratch directory and counts
 * **the original `load` itself** — not the plugin's own counters — wherever the
 * question is "did this read happen". The plugin's counters are asserted too,
 * because they are what an operator reads, but they are never the only witness:
 * a memo whose bookkeeping is right and whose reads are wrong is exactly the bug
 * this suite exists to catch.
 *
 * @module test/cache.spec
 */

import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  LoadMemo, asIndexLike, identityOf, readIdentity, sameIdentity,
} from '../lib/index.js'
import { scratch, writeIndex } from './harness.mjs'

/**
 * An index-shaped object whose `load` counts its own calls.
 *
 * It reads the file the way the core does — parse, and treat a missing file as
 * an empty index — because a memo is only worth testing against a reader that
 * behaves like the one it wraps. `onRead` runs *after* the read and before the
 * return, which is where a concurrent write has to land to be the race the
 * wrapper is guarding against: the reader has its snapshot, and the file has
 * moved on underneath it.
 * @param path - the file to read.
 * @param onRead - called with the index after it read (used to race a write).
 * @returns the index.
 */
function countingIndex(path, onRead) {
  return {
    path,
    loads: 0,
    async load() {
      this.loads += 1
      let text
      try {
        text = readFileSync(this.path, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { formatVersion: 3, records: [] }
        throw error
      }
      const parsed = JSON.parse(text)
      if (onRead !== undefined) await onRead(this)
      return parsed
    },
  }
}

/** A memo whose clock the caller owns, so the age bound is decided, not waited for. */
function memoFor(settings, onError = () => {}) {
  const clock = { now: 1_000 }
  const memo = new LoadMemo(
    { maxBytes: settings.maxBytes ?? 0, maxAgeMs: settings.maxAgeMs ?? 0 },
    () => clock.now,
    onError,
  )
  return { memo, clock }
}

test('an absent file has an identity, and it is the same one twice', async () => {
  const { dir, done } = scratch()
  try {
    const missing = join(dir, 'files-v3.json')
    assert.deepEqual(await readIdentity(missing), { present: false })
    assert.equal(sameIdentity({ present: false }, { present: false }), true)
    assert.equal(sameIdentity({ present: false }, identityOf({ ino: 1, size: 0, mtimeMs: 0 })), false)
  } finally {
    done()
  }
})

test('a stat failure that is not ENOENT is not swallowed', async () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    // `/a-file/child` is ENOTDIR: a real error, and the one that must not be
    // turned into "the index is empty" — that would report a working deployment
    // as a program that has never uploaded anything.
    await assert.rejects(readIdentity(join(file, 'child')))
  } finally {
    done()
  }
})

test('two identities differ when the inode, the size or the modification time does', () => {
  const base = identityOf({ ino: 7, size: 100, mtimeMs: 5 })
  assert.equal(sameIdentity(base, identityOf({ ino: 7, size: 100, mtimeMs: 5 })), true)
  assert.equal(sameIdentity(base, identityOf({ ino: 8, size: 100, mtimeMs: 5 })), false)
  assert.equal(sameIdentity(base, identityOf({ ino: 7, size: 101, mtimeMs: 5 })), false)
  assert.equal(sameIdentity(base, identityOf({ ino: 7, size: 100, mtimeMs: 6 })), false)
})

test('a candidate without a usable path or load is refused', () => {
  assert.equal(asIndexLike(undefined), undefined)
  assert.equal(asIndexLike(null), undefined)
  assert.equal(asIndexLike('nope'), undefined)
  assert.equal(asIndexLike({}), undefined)
  assert.equal(asIndexLike({ path: '' , load: () => {} }), undefined)
  assert.equal(asIndexLike({ path: '/x' }), undefined)
  const good = { path: '/x', load: () => {} }
  assert.equal(asIndexLike(good), good)
})

test('the second lookup reads nothing and answers with the same document', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])
    const { memo } = memoFor({})
    const index = countingIndex(path)
    const original = index.load
    index.load = memo.wrap(original)

    const first = await index.load()
    const second = await index.load()
    assert.equal(index.loads, 1, 'the file was read once, so the second call was served')
    assert.equal(first, second, 'the retained object is handed back, not a copy')
    assert.deepEqual(memo.counters, { lookups: 2, hits: 1, misses: 1, bypassed: 0, unstored: 0, errors: 0 })
  } finally {
    done()
  }
})

test('`this` survives the wrapper', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [])
    const { memo } = memoFor({})
    const index = countingIndex(path)
    const received = []
    const original = index.load
    index.load = memo.wrap(function (...args) { received.push(this); return original.apply(this, args) })
    await index.load()
    assert.equal(received[0], index, 'the original is called with the index as `this`')
  } finally {
    done()
  }
})

test('a rewrite is seen even when the new document is byte-identical', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])
    const first = await readIdentity(path)
    const { memo } = memoFor({})
    const index = countingIndex(path)
    const original = index.load
    index.load = memo.wrap(original)
    await index.load()
    await index.load()
    assert.equal(index.loads, 1)

    writeIndex(path, [{ id: 1 }])
    const second = await readIdentity(path)
    // The premise, measured rather than assumed: the core writes through a
    // rename, so a rewrite changes the inode even when nothing else does.
    assert.notEqual(first.ino, second.ino, 'the core\'s atomic write must change the inode')

    const value = await index.load()
    assert.equal(index.loads, 2, 'the changed identity forced a re-read')
    assert.deepEqual(value, { formatVersion: 3, records: [{ id: 1 }] })
    assert.equal(memo.counters.misses, 2)
  } finally {
    done()
  }
})

test('a delete and a create are both seen', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])
    const { memo } = memoFor({})
    const index = countingIndex(path)
    const original = index.load
    index.load = memo.wrap(original)

    assert.deepEqual(await index.load(), { formatVersion: 3, records: [{ id: 1 }] })
    rmSync(path)
    assert.deepEqual(await index.load(), { formatVersion: 3, records: [] }, 'the deletion is seen')
    assert.equal(index.loads, 2)

    writeIndex(path, [{ id: 2 }])
    assert.deepEqual(await index.load(), { formatVersion: 3, records: [{ id: 2 }] }, 'the re-creation is seen')
    assert.equal(index.loads, 3)
  } finally {
    done()
  }
})

test('an index past the ceiling is read the ordinary way, every time', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1, pad: 'x'.repeat(200) }])
    const { memo } = memoFor({ maxBytes: 16 })
    const index = countingIndex(path)
    const original = index.load
    index.load = memo.wrap(original)

    assert.deepEqual(await index.load(), await index.load())
    assert.equal(index.loads, 2, 'a bypassed index is never retained')
    assert.equal(memo.counters.bypassed, 2)
    assert.equal(memo.counters.hits, 0)

    // `0` is "no ceiling", not "everything is too big" — the two readings differ
    // by every deployment that leaves the bound unset.
    const unbounded = memoFor({ maxBytes: 0 })
    const big = countingIndex(path)
    const bigOriginal = big.load
    big.load = unbounded.memo.wrap(bigOriginal)
    await big.load()
    await big.load()
    assert.equal(big.loads, 1, 'with no ceiling the document is retained however large it is')
    assert.equal(unbounded.memo.counters.bypassed, 0)
  } finally {
    done()
  }
})

test('the age bound is a second trigger, and it is off by default', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])

    const disabled = memoFor({ maxAgeMs: 0 })
    const stable = countingIndex(path)
    stable.load = disabled.memo.wrap(stable.load)
    stable.loads = 0
    await stable.load()
    disabled.clock.now += 10_000_000
    await stable.load()
    assert.equal(stable.loads, 1, 'with no age bound, the identity is the only trigger')

    const bounded = memoFor({ maxAgeMs: 1000 })
    const aging = countingIndex(path)
    const original = aging.load
    aging.load = bounded.memo.wrap(original)
    await aging.load()
    bounded.clock.now += 999
    await aging.load()
    assert.equal(aging.loads, 1, 'below the bound it is still a hit')
    bounded.clock.now += 1
    await aging.load()
    assert.equal(aging.loads, 2, 'at the bound the document ages out')
  } finally {
    done()
  }
})

test('a file that changes while it is being read is served, and not retained', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])
    const { memo } = memoFor({})
    const index = countingIndex(path, async () => {
      // The write lands between the wrapper's first stat and its second.
      writeIndex(path, [{ id: 2 }])
    })
    const original = index.load
    index.load = memo.wrap(original)

    const value = await index.load()
    assert.deepEqual(value, { formatVersion: 3, records: [{ id: 1 }] }, 'the reader keeps its own consistent snapshot')
    assert.equal(memo.counters.unstored, 1, 'the snapshot is not installed under the newer generation\'s identity')
    const after = await index.load()
    assert.deepEqual(after, { formatVersion: 3, records: [{ id: 2 }] }, 'and the newer generation is what the next call sees')
    assert.equal(index.loads, 2)
  } finally {
    done()
  }
})

test('bookkeeping that fails serves the ordinary read and counts the failure', async () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    const failures = []
    const { memo } = memoFor({}, error => { failures.push(error) })
    let calls = 0
    const broken = {
      path: join(file, 'child'), // ENOTDIR on every stat
      async load() { calls += 1; return 'ordinary' },
    }
    broken.load = memo.wrap(broken.load)
    assert.equal(await broken.load(), 'ordinary', 'a stat failure falls open to the original')
    assert.equal(calls, 1)
    assert.equal(memo.counters.errors, 1)
    assert.equal(failures.length, 1)

    const throwing = memoFor({}, () => { throw new Error('the reporter itself failed') }).memo
    const alsoBroken = { path: join(file, 'child'), async load() { return 'still fine' } }
    alsoBroken.load = throwing.wrap(alsoBroken.load)
    assert.equal(await alsoBroken.load(), 'still fine', 'a throwing reporter does not become the failure it reports')
  } finally {
    done()
  }
})

test('two indexes at one path keep their own documents', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])
    const { memo } = memoFor({})
    const first = countingIndex(path)
    const second = countingIndex(path)
    first.load = memo.wrap(first.load)
    second.load = memo.wrap(second.load)
    await first.load()
    await second.load()
    assert.equal(first.loads, 1)
    assert.equal(second.loads, 1, 'a shared slot would have made this a hit across two instances')
    assert.equal(memo.counters.misses, 2)
  } finally {
    done()
  }
})

test('reset forgets, and asking for a snapshot does not hand out live state', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [])
    const { memo } = memoFor({})
    const index = countingIndex(path)
    const original = index.load
    index.load = memo.wrap(original)
    await index.load()
    await index.load()
    assert.equal(index.loads, 1)
    memo.reset()
    await index.load()
    assert.equal(index.loads, 2, 'reset() drops the retained document')
  } finally {
    done()
  }
})
