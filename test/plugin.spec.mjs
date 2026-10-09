/**
 * The plugin, mounted in a real cordis context on top of the real registry and
 * the real DeepSeek adapter.
 *
 * Two things are proved here that no unit test can prove: that the object the
 * plugin patches is the object `get()` calls — asserted by making the file
 * unreadable *after* the first lookup and watching the second one succeed
 * anyway, which is only possible if no read happened — and that unmounting puts
 * everything back, asserted by the same trick in reverse.
 *
 * The unreadable-file arm needs the process to be subject to file permissions;
 * as root, `chmod 000` is advisory and the arm is skipped rather than reported
 * as passing.
 *
 * @module test/plugin.spec
 */

import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DeepSeekUploadIndex } from '@deepseek-ai/dsh-llm-deepseek'
import { adapterAt, logText, permissionsBite, record, register, scratch, service, SCOPE, VARIANT, world, writeIndex } from './harness.mjs'

const NOW = 1_700_000_000_000

/** A stub adapter that satisfies the registry's own metadata checks. */
function stubAdapter(index) {
  return {
    files: { index },
    providerInfo: provider => ({ id: provider, name: 'Stub' }),
    providerRetryPolicy: () => undefined,
  }
}

/** Whether `load` has been replaced on the instance rather than inherited. */
function patched(index) {
  return Object.hasOwn(index, 'load') && index.load !== Object.getPrototypeOf(index)?.load
}

test('an adapter handed over after mount is covered, and its seam is named', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world()
    register(harness, adapter)
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.mode, 'cache')
    assert.deepEqual(snapshot.coverage.covered, [{ path: index.path, source: 'register-adapter' }])
    assert.ok(patched(index), 'the live instance carries the wrapper')
    assert.match(logText(harness.logged), /now retaining the parsed document for/)
    assert.match(logText(harness.logged), /mounted in cache mode/)
  } finally {
    done()
  }
})

test('an adapter registered before mount is reached through the registry map', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world({ plugin: false })
    register(harness, adapter)
    await harness.mount()
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.coverage.covered.map(entry => entry.path), [index.path])
    assert.equal(snapshot.coverage.covered[0].source, 'adapter-registry')
    assert.equal(snapshot.coverage.passes, 1)
    assert.ok(patched(index))
  } finally {
    done()
  }
})

test('the seam is upgraded when the host hands over an adapter the map saw first', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world()
    // The registry announces the route change *during* `registerAdapter`, so the
    // map pass reaches this index before the wrapping seam can name it.
    register(harness, adapter)
    const covered = service(harness).snapshot().coverage.covered
    assert.equal(covered.length, 1, 'the two seams must not produce two entries')
    assert.equal(covered[0].source, 'register-adapter', 'the public seam is the one that should be reported')
    assert.equal(service(harness).snapshot().coverage.passes, 2, 'the initial pass and the announced change')
  } finally {
    done()
  }
})

test('a covered index serves its second lookup without reading the file', async t => {
  if (!permissionsBite) return t.skip('running as root: chmod 000 is advisory')
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [record(SCOPE, VARIANT, 'file-1')])
    const { adapter, index } = adapterAt(path)
    const harness = await world()
    register(harness, adapter)

    const first = await index.get(SCOPE, VARIANT, NOW, 0)
    assert.equal(first?.fileId, 'file-1', 'the mapping is resolved the ordinary way')
    chmodSync(path, 0o000)
    const second = await index.get(SCOPE, VARIANT, NOW, 0)
    assert.equal(second?.fileId, 'file-1', 'the second lookup was served from the retained document, not the file')
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.misses, 1)
    assert.equal(snapshot.counters.hits, 1)
  } finally {
    done()
  }
})

test('the control arm: without the plugin the same second lookup fails', async t => {
  if (!permissionsBite) return t.skip('running as root: chmod 000 is advisory')
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [record(SCOPE, VARIANT, 'file-1')])
    const { adapter, index } = adapterAt(path)
    const harness = await world({ plugin: false })
    register(harness, adapter)
    chmodSync(path, 0o600)
    assert.equal((await index.get(SCOPE, VARIANT, NOW, 0))?.fileId, 'file-1')
    chmodSync(path, 0o000)
    // The refusal is the point: it shows the previous arm succeeded because the
    // read was skipped, not because the file was readable after all.
    await assert.rejects(index.get(SCOPE, VARIANT, NOW, 0), error => error?.code === 'EACCES')
  } finally {
    done()
  }
})

test('a write through the core API is visible to the next lookup', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [])
    const { adapter, index } = adapterAt(path)
    const harness = await world()
    register(harness, adapter)
    assert.equal(await index.get(SCOPE, VARIANT, NOW, 0), undefined)
    const committed = await index.commit(record(SCOPE, VARIANT, 'file-9'), NOW, 0)
    assert.equal(committed.accepted, true)
    assert.equal((await index.get(SCOPE, VARIANT, NOW, 0))?.fileId, 'file-9', 'the atomic write invalidated the memo')
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(onDisk.records.map(entry => entry.fileId), ['file-9'])
    assert.equal(service(harness).snapshot().counters.misses, 2, 'the empty read and the read after the commit')
  } finally {
    done()
  }
})

test('unmounting restores the instance and stops serving', async t => {
  if (!permissionsBite) return t.skip('running as root: chmod 000 is advisory')
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [record(SCOPE, VARIANT, 'file-1')])
    const { adapter, index } = adapterAt(path)
    const harness = await world({ plugin: false })
    register(harness, adapter)
    await harness.mount()
    assert.ok(patched(index))
    assert.equal((await index.get(SCOPE, VARIANT, NOW, 0))?.fileId, 'file-1')
    await harness.dispose()
    assert.equal(Object.hasOwn(index, 'load'), false, 'the wrapper is removed, not left as an own property')
    assert.equal(index.load, Object.getPrototypeOf(index).load, 'the prototype method is what is called again')
    assert.equal(
      Object.hasOwn(harness.ctx.get('llm'), 'registerAdapter'),
      false,
      'the registry method is inherited again, not shadowed by a restored copy',
    )
    chmodSync(path, 0o000)
    await assert.rejects(index.get(SCOPE, VARIANT, NOW, 0), error => error?.code === 'EACCES', 'nothing is served after unmount')
  } finally {
    done()
  }
})

test('an own-property load is restored as an own property', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [{ id: 1 }])
    const original = async function () { return JSON.parse(readFileSync(this.path, 'utf8')) }
    const index = { path, load: original }
    const harness = await world()
    register(harness, stubAdapter(index))
    assert.notEqual(index.load, original, 'the memo is installed')
    assert.equal(service(harness).snapshot().coverage.covered[0].source, 'register-adapter')
    const document = { formatVersion: 3, records: [{ id: 1 }] }
    assert.deepEqual(await index.load(), document)
    await harness.dispose()
    assert.equal(index.load, original, 'the own property is put back, not deleted')
    assert.deepEqual(await index.load(), document)
  } finally {
    done()
  }
})

test('observe counts the lookups and installs nothing', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [])
    const { adapter, index } = adapterAt(path)
    const harness = await world({ config: { mode: 'observe' } })
    register(harness, adapter)
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.mode, 'observe')
    assert.deepEqual(snapshot.coverage.covered, [], 'an unpatched index is never reported as covered')
    assert.deepEqual(snapshot.coverage.observed, [{ path: index.path, source: 'register-adapter' }])
    assert.equal(patched(index), false, 'observe patches nothing')
    assert.equal(typeof index.load, 'function')
  } finally {
    done()
  }
})

test('off installs nothing and provides nothing', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world({ config: { mode: 'off' } })
    register(harness, adapter)
    assert.equal(service(harness), undefined, 'no service is provided in off mode')
    assert.equal(patched(index), false)
  } finally {
    done()
  }
})

test('an index the plugin cannot patch is reported, not swallowed', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [])
    const index = Object.freeze(new DeepSeekUploadIndex(path))
    const harness = await world()
    register(harness, {
      files: { index },
      providerInfo: provider => ({ id: provider, name: 'Stub' }),
      providerRetryPolicy: () => undefined,
    })
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.coverage.covered, [])
    assert.equal(snapshot.coverage.skipped.length, 1)
    assert.equal(snapshot.coverage.skipped[0].path, path)
    assert.match(snapshot.coverage.skipped[0].reason, /load could not be replaced/)
  } finally {
    done()
  }
})

test('onlyPaths excludes an index and says so', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world({ config: { onlyPaths: ['/nowhere-in-particular'] } })
    register(harness, adapter)
    const coverage = service(harness).snapshot().coverage
    assert.deepEqual(coverage.covered, [])
    assert.deepEqual(coverage.skipped, [{
      path: index.path,
      reason: 'out of scope: the configured onlyPaths prefixes do not cover it',
    }])
    assert.ok(coverage.notCovered.some(line => line.includes('/nowhere-in-particular')), 'the report names the filter')
    assert.equal(patched(index), false)
  } finally {
    done()
  }
})

test('a repeated discovery pass does not double-cover or double-report', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world()
    register(harness, adapter)
    // A second registration for a different route set, same adapter: the
    // registry announces again and the pass re-reads the map.
    register(harness, adapter, ['deepseek-beta'])
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.coverage.covered.length, 1)
    assert.equal(snapshot.coverage.covered[0].path, index.path)
    assert.equal(snapshot.coverage.passes, 3)
    assert.equal(snapshot.coverage.adaptersSeen, 2, 'both hand-offs are counted')
  } finally {
    done()
  }
})

test('reset drops the retained document and zeroes the counters', async t => {
  if (!permissionsBite) return t.skip('running as root: chmod 000 is advisory')
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [record(SCOPE, VARIANT, 'file-1')])
    const { adapter, index } = adapterAt(path)
    const harness = await world()
    register(harness, adapter)
    await index.get(SCOPE, VARIANT, NOW, 0)
    const cache = service(harness)
    assert.equal(cache.snapshot().counters.misses, 1)
    cache.reset()
    assert.deepEqual(cache.snapshot().counters, { lookups: 0, hits: 0, misses: 0, bypassed: 0, unstored: 0, errors: 0 })
    chmodSync(path, 0o000)
    await assert.rejects(index.get(SCOPE, VARIANT, NOW, 0), error => error?.code === 'EACCES', 'the document is gone')
  } finally {
    done()
  }
})

test('an index larger than maxBytes is read the ordinary way and reported', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    writeIndex(path, [record(SCOPE, VARIANT, 'file-1')])
    const { adapter, index } = adapterAt(path)
    const harness = await world({ config: { maxBytes: 8 } })
    register(harness, adapter)
    const cache = service(harness)
    await index.get(SCOPE, VARIANT, NOW, 0)
    await index.get(SCOPE, VARIANT, NOW, 0)
    assert.equal(cache.snapshot().counters.bypassed, 2)
    assert.equal(cache.snapshot().counters.hits, 0)
    assert.ok(cache.snapshot().coverage.notCovered.some(line => line.includes('larger than 8 bytes')))
  } finally {
    done()
  }
})

test('the report always states the blind spots it cannot close', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter } = adapterAt(join(dir, 'files-v3.json'))
    const harness = await world({ config: { report: false } })
    register(harness, adapter)
    const lines = service(harness).snapshot().coverage.notCovered
    assert.ok(lines.some(line => line.includes('no registered adapter owns')), 'the registry boundary is stated')
    assert.ok(lines.some(line => line.includes('per instance')), 'the timing boundary is stated')
    assert.equal(logText(harness.logged).includes('mounted in cache mode'), false, 'report: false silences the mount line')
  } finally {
    done()
  }
})
