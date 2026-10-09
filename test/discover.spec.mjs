/**
 * Discovery, held to the two seams it claims and to the one it does not.
 *
 * The plugin reaches its target through private fields, so the guards around
 * those fields are load-bearing: a walk that threw on an unexpected shape would
 * take a deployment down looking for a file, and a walk that accepted anything
 * as an index would patch a stranger's `load`. Both directions are asserted
 * here, and the adapter half is asserted against the **shipped class** rather
 * than a fixture that agrees with the plugin.
 *
 * @module test/discover.spec
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { adaptersOf, discover, indexOfAdapter, inScope } from '../lib/index.js'
import { adapterAt, scratch } from './harness.mjs'

test('the adapter walk accepts the shipped shape and nothing else', async () => {
  const { dir, done } = scratch()
  try {
    const path = join(dir, 'files-v3.json')
    const { adapter, index } = adapterAt(path)
    assert.equal(indexOfAdapter(adapter), index, 'the shipped adapter\'s own index is found')
    assert.equal(index.path, path, 'and it is the same object the store holds')
  } finally {
    done()
  }
})

test('the adapter walk refuses every shape that is not one', () => {
  assert.equal(indexOfAdapter(undefined), undefined)
  assert.equal(indexOfAdapter(null), undefined)
  assert.equal(indexOfAdapter('adapter'), undefined)
  assert.equal(indexOfAdapter({}), undefined)
  assert.equal(indexOfAdapter({ files: null }), undefined)
  assert.equal(indexOfAdapter({ files: {} }), undefined)
  assert.equal(indexOfAdapter({ files: { index: { path: '/a' } } }), undefined, 'load must be a function')
  assert.equal(indexOfAdapter({ files: { index: { path: '', load: () => {} } } }), undefined, 'path must not be empty')
})

test('the registry read accepts a map of registrations and nothing else', () => {
  const adapter = { files: { index: { path: '/a', load: () => {} } } }
  assert.deepEqual(adaptersOf(undefined), [])
  assert.deepEqual(adaptersOf(null), [])
  assert.deepEqual(adaptersOf({ adapters: [] }), [], 'a non-Map is not a registry')
  assert.deepEqual(adaptersOf({ adapters: new Map([['x', null], ['y', {}], ['z', { adapter }]]) }), [adapter])
  assert.deepEqual(
    adaptersOf({ adapters: new Map([['a', { adapter }], ['b', { adapter }]]) }),
    [adapter, adapter],
    'two routes on one adapter report it twice, which is what the caller deduplicates',
  )
  assert.deepEqual(adaptersOf({ adapters: new Map([['a', { adapter: undefined }]]) }), [])
})

test('the path filter is a prefix test, and empty means everything', () => {
  assert.equal(inScope('/anything', []), true)
  assert.equal(inScope('/home/u/.dsh/llm-deepseek/files-v3.json', ['/home/u/.dsh']), true)
  assert.equal(inScope('/home/u/.dsh/llm-deepseek/files-v3.json', ['/srv']), false)
  assert.equal(inScope('/srv/x', ['/home', '/srv']), true)
})

test('discovery deduplicates by instance and reports the seam that found each one', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const other = adapterAt(join(dir, 'other.json'))
    const llm = { adapters: new Map([['a', { adapter }], ['b', { adapter }], ['c', { adapter: other.adapter }]]) }
    const targets = discover(llm, [])
    assert.equal(targets.length, 2, 'the same instance reached twice is one target')
    assert.deepEqual(targets.map(target => target.path), [index.path, other.index.path])
    assert.ok(targets.every(target => target.source === 'adapter-registry'))
    assert.ok(targets.every(target => typeof target.index.load === 'function'))
  } finally {
    done()
  }
})

test('discovery honours the path filter and survives a registry that is not one', async () => {
  const { dir, done } = scratch()
  try {
    const { adapter, index } = adapterAt(join(dir, 'files-v3.json'))
    const llm = { adapters: new Map([['a', { adapter }]]) }
    assert.deepEqual(discover(llm, ['/nope']), [])
    assert.deepEqual(discover({}, []), [])
    assert.deepEqual(discover(undefined, []), [])
    assert.equal(discover(llm, [dir]).length, 1)
    assert.equal(discover(llm, [dir])[0].index, index)
  } finally {
    done()
  }
})
