/**
 * The configuration, which is the part of a fail-open plugin that decides what
 * "fail open" means.
 *
 * Every field here falls back per field rather than per object, because a plugin
 * that refused to mount because an operator wrote `maxBytes: "8MiB"` would be a
 * worse trade than one that reads what it was given and ignores the rest. The
 * assertions are therefore about the fallbacks: which inputs are honoured, and
 * which are quietly replaced.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultConfig, normalizeConfig } from '../lib/index.js'

test('an empty configuration is the documented default', () => {
  assert.deepEqual(normalizeConfig({}), {
    mode: 'cache',
    maxBytes: 8 * 1024 * 1024,
    maxAgeMs: 0,
    onlyPaths: [],
    report: true,
  })
  assert.deepEqual(normalizeConfig({}), { ...defaultConfig, onlyPaths: [...defaultConfig.onlyPaths] })
})

test('the three modes are kept and nothing else is', () => {
  assert.equal(normalizeConfig({ mode: 'observe' }).mode, 'observe')
  assert.equal(normalizeConfig({ mode: 'off' }).mode, 'off')
  assert.equal(normalizeConfig({ mode: 'cache' }).mode, 'cache')
  assert.equal(normalizeConfig({ mode: 'nonsense' }).mode, 'cache', 'an unknown mode is the default, not a crash')
  assert.equal(normalizeConfig({ mode: undefined }).mode, 'cache')
})

test('a byte bound has to be a usable count', () => {
  assert.equal(normalizeConfig({ maxBytes: 0 }).maxBytes, 0, 'zero means no ceiling, and it survives')
  assert.equal(normalizeConfig({ maxBytes: 1024 }).maxBytes, 1024)
  assert.equal(normalizeConfig({ maxBytes: -1 }).maxBytes, defaultConfig.maxBytes, 'a negative bound is not a bound')
  assert.equal(normalizeConfig({ maxBytes: 1.5 }).maxBytes, defaultConfig.maxBytes, 'a fractional byte count is a typo')
  assert.equal(normalizeConfig({ maxBytes: Number.NaN }).maxBytes, defaultConfig.maxBytes)
  assert.equal(normalizeConfig({ maxBytes: 1 / 0 }).maxBytes, defaultConfig.maxBytes, 'Infinity is not an integer')
})

test('the age bound follows the same rule', () => {
  assert.equal(normalizeConfig({ maxAgeMs: 0 }).maxAgeMs, 0)
  assert.equal(normalizeConfig({ maxAgeMs: 250 }).maxAgeMs, 250)
  assert.equal(normalizeConfig({ maxAgeMs: -5 }).maxAgeMs, defaultConfig.maxAgeMs)
  assert.equal(normalizeConfig({ maxAgeMs: 0.5 }).maxAgeMs, defaultConfig.maxAgeMs)
})

test('the path filter keeps only usable prefixes', () => {
  assert.deepEqual(normalizeConfig({ onlyPaths: undefined }).onlyPaths, [], 'anything that is not a list is no filter')
  assert.deepEqual(normalizeConfig({ onlyPaths: '/a/b' }).onlyPaths, [], 'a bare string is not a list of prefixes')
  assert.deepEqual(normalizeConfig({ onlyPaths: [] }).onlyPaths, [])
  assert.deepEqual(normalizeConfig({ onlyPaths: ['/a', '  /b  '] }).onlyPaths, ['/a', '/b'], 'entries are trimmed')
  assert.deepEqual(normalizeConfig({ onlyPaths: ['   '] }).onlyPaths, [], 'a whitespace-only prefix would match everything')
  assert.deepEqual(normalizeConfig({ onlyPaths: ['/a', 7, null, '/b'] }).onlyPaths, ['/a', '/b'], 'non-strings are dropped')
  const long = normalizeConfig({ onlyPaths: ['x'.repeat(5000)] }).onlyPaths
  assert.equal(long.length, 1)
  assert.equal(long[0].length, 1024, 'a prefix is bounded: it is compared against every index path')
})

test('report is a boolean or the default', () => {
  assert.equal(normalizeConfig({ report: false }).report, false)
  assert.equal(normalizeConfig({ report: true }).report, true)
  assert.equal(normalizeConfig({ report: 'yes' }).report, true, 'a string is not a flag')
})
