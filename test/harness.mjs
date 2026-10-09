/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime` from
 * `@deepseek-ai/dsh-llm`, and a REAL `DeepSeekAdapter` from
 * `@deepseek-ai/dsh-llm-deepseek` holding a REAL `DeepSeekUploadIndex`.
 *
 * Nothing about the seam is simulated. The awkward part of this plugin is that
 * its target is a private field of a private field of a private field
 * (`adapter.files.index`), and a test that fabricated that shape would prove
 * only that the plugin agrees with the test. So the adapter here is the shipped
 * class, constructed the way the shipped host constructs it, and the assertion
 * that matters — "the object the plugin patched is the object `get()` calls" —
 * is made against the real object.
 *
 * Two fabricated articles, both deliberate:
 *
 * - the index **path** is a temp file, so a test can write, rename and delete the
 *   index without touching a real `DSH_HOME`;
 * - the adapter's transport dependencies are stubs, because no test here makes an
 *   HTTP request.
 *
 * @module test/harness
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, DeepSeekFileStore, DeepSeekUploadIndex } from '@deepseek-ai/dsh-llm-deepseek'
import * as plugin from '../lib/index.js'

/** A scratch directory that is removed when `done` is called. */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'upload-index-cache-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Write an index file the way the core does: a sibling then a rename.
 *
 * `writeFileAtomic` renames, which is the whole reason the plugin's identity key
 * works, so the harness writes the same way rather than duplicating the premise
 * with a plain `writeFileSync`. The inode is asserted to have changed by the
 * tests that depend on it, so the premise is measured rather than assumed.
 * @param path - the index path.
 * @param records - the records to store.
 * @returns the identity the file has afterwards.
 */
export function writeIndex(path, records) {
  const temporary = `${path}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ formatVersion: 3, records }, undefined, 2)}\n`)
  renameSync(temporary, path)
}

/** A well-formed v3 record, so a fixture is never rejected by the real parser. */
export function record(scope, variantId, fileId, overrides = {}) {
  return {
    scope,
    attachmentId: `sha256:${'a'.repeat(64)}`,
    variantId,
    fileId,
    bytes: 1024,
    createdAt: 1,
    expiresAt: 4_000_000_000_000,
    ...overrides,
  }
}

/** Scope and variant digests that satisfy the core parser's shape checks. */
export const SCOPE = '1'.repeat(64)
export const VARIANT = `sha256:${'2'.repeat(64)}`

/**
 * A real registered adapter, holding a real upload index at `path`.
 *
 * `resolveFiles` is the seam the shipped host leaves `undefined`; supplying it
 * is how a test chooses the index path. Everything below it — the store, the
 * index, the private fields the plugin walks — is the published class.
 * @param path - the index file the adapter's store will use.
 * @returns the adapter and the index it holds.
 */
export function adapterAt(path) {
  const index = new DeepSeekUploadIndex(path)
  const adapter = new DeepSeekAdapter({
    options: () => ({ retryPolicy: undefined }),
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'test-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    resolveFiles: () => new DeepSeekFileStore({ index }),
  })
  return { adapter, index, store: adapter.files ?? undefined }
}

/**
 * Mount a real context with the real LLM registry.
 *
 * `plugin: false` defers the mount to the caller — the same world, with the
 * plugin out of the way until `mount()` is called, so a test can register an
 * adapter *first* and prove the registry-map seam covers it. `mount()` works
 * either way; `plugin: false` only changes whether it has already happened.
 * @param spec - `plugin: false` defers the mount; `config` is its configuration.
 * @returns the context, the captured log, `mount`, and `dispose`.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)
  const harness = {
    ctx,
    logged,
    /** The mounted fork, once `mount()` has run. */
    fork: undefined,
    mount: async () => {
      harness.fork = await ctx.plugin(plugin, spec.config ?? {})
      return harness
    },
    /** Unmount this plugin, leaving the registry and every adapter in place. */
    dispose: async () => {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }
  if (spec.plugin !== false) await harness.mount()
  return harness
}

/**
 * Register an adapter the way the deepseek host does.
 * @param harness - a harness from {@link world}.
 * @param adapter - the adapter to register.
 * @param routes - the provider routes it answers.
 * @returns whatever `registerAdapter` returned.
 */
export function register(harness, adapter, routes = ['deepseek-official']) {
  return harness.ctx.llm.registerAdapter(routes, adapter)
}

/** The service this plugin provides, or `undefined` when it did not mount it. */
export function service(harness) {
  return harness.ctx.get('uploadIndexCache')
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}

/**
 * Wait until `check` holds, or give up.
 *
 * Discovery happens synchronously inside `registerAdapter`, so most assertions
 * need no wait at all — this exists for the event-driven path, where cordis
 * dispatches `llm/adapters-updated` on its own turn.
 * @param check - the predicate.
 * @param turns - how many microtask turns to allow.
 * @returns whether the predicate held.
 */
export async function settle(check, turns = 50) {
  for (let index = 0; index < turns; index += 1) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return check()
}

/** Whether the process can be relied on to refuse a `chmod 000` read (not root). */
export const permissionsBite = typeof process.getuid !== 'function' || process.getuid() !== 0
