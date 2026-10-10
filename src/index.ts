/**
 * One image, one whole-index parse — and the memo that removes the parse without
 * touching anything the parser decides.
 *
 * ## The gap this closes
 *
 * Resolving a retained image to its DeepSeek file id costs a **whole-index read
 * and re-validation**, per image, per HTTP attempt:
 *
 * ```
 * adapter.ts:95   prepareFileIds(messages, versions, files)
 * images.ts:99      for each image reference: await files.resolve(...)
 * request-files.ts:116  resolve → DeepSeekFileStore.ensureUploaded
 * file-store.ts:188     ensureUploadedOnce → (:200) this.index.get(scope, variantId, now, margin)
 * upload-index.ts:149   get() → (:123) load() = readFile + parse + validate + linear .find
 * ```
 *
 * The store's `inflight` map deduplicates only while an upload promise has not
 * settled, so it does not help a session whose images are already uploaded —
 * which is every request after the first. Measured on the published
 * `0.2.1-alpha.1` bundle with a 500-record index, that read-and-parse is 99.3% of
 * a lookup; the linear `.find` is 0.7%.
 *
 * Reported as #8814, with the fix and a keyless benchmark, by the person who
 * profiled it.
 *
 * ## What this plugin does, and what it refuses to do
 *
 * It **memoizes `load()`** — the read and the parse — and re-reads only when the
 * file's identity (`ino`, `size`, `mtimeMs`) changes, which every local write
 * does because writes go through `writeFileAtomic`'s rename. It does **not**
 * re-implement the parser, the expiry rule, the lock, the atomic write or the v3
 * format, and it does not patch `get()`: the linear scan stays core's, so the
 * total saving is bounded by what a memo of `load()` can honestly claim (99.3%
 * of the lookup, minus the ~2.3% a `stat` costs). A cache that also guessed at
 * `get()`'s semantics would be a reimplementation of the thing it is speeding
 * up, and its disagreements with core would surface as expired file ids.
 *
 * ## Where it attaches, and why it has to work for it
 *
 * `DeepSeekUploadIndex` is not a cordis service: the deepseek host constructs
 * `DeepSeekAdapter` with no `resolveFiles`, and the adapter constructs a store
 * that constructs the index — a private field of a private field. So the plugin
 * finds live instances (`src/discover.ts` states both seams, one public, one
 * best-effort) and patches the **instance**, never a prototype: a prototype
 * belongs to whichever copy of the package happened to be imported, and patching
 * the wrong copy is the failure mode this repository has already produced twice.
 *
 * Instances constructed outside a registered adapter — a plugin building its own
 * `DeepSeekFileStore`, a test — are **not** covered, and the plugin says so
 * instead of implying otherwise.
 *
 * ## Why it is not a one-line monkey patch
 *
 * Because "how often is this read in *your* deployment" is a question with a
 * different answer on every deployment, and a silent cache answers it by
 * assumption. `mode: 'observe'` counts the same lookups and patches nothing;
 * `observe` is meant to be run first. The counters and the coverage report are
 * exposed as a service for the same reason: this plugin's honest claim is not
 * "it is fast now", it is "*this many* reads were served from *this* identity,
 * and *these* places are not covered".
 *
 * Fail-open throughout: a discovery or a bookkeeping error is logged once and
 * the ordinary read happens. A cache whose bug froze every image lookup would be
 * a worse failure than the cost it removes.
 *
 * @module @argszero/dsh-upload-index-cache
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { LoadMemo, asIndexLike } from './cache.ts'
import type { IndexLike, LoadFunction, MemoCounters, MemoSettings } from './cache.ts'
import { discover, indexOfAdapter, inScope } from './discover.ts'
import type { IndexTarget, TargetSource } from './discover.ts'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { CacheMode, Config, Settings } from './config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'upload-index-cache'

/**
 * The service this plugin reads. The deepseek provider's index is reachable only
 * through the LLM registry, so the registry is a hard requirement — without it
 * there is nothing to cover and mounting later is not better than not mounting.
 */
export const inject = ['llm']

export type { CacheMode, Config, Settings } from './config.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export type { IndexIdentity, IndexLike, LoadFunction, MemoCounters, MemoSettings } from './cache.ts'
export { LoadMemo, asIndexLike, identityOf, readIdentity, sameIdentity } from './cache.ts'
export type { IndexTarget, TargetSource } from './discover.ts'
export { adaptersOf, discover, inScope, indexOfAdapter } from './discover.ts'

/** One covered index, as the report names it. */
export interface CoveredTarget {
  /** The index's own path. */
  readonly path: string
  /** The seam that found it. */
  readonly source: TargetSource
}

/** An index the plugin found but did not cover, and why. */
export interface SkippedTarget {
  readonly path: string
  readonly reason: string
}

/**
 * What the plugin covered, and — the part a reader needs — what it did not.
 *
 * `notCovered` is not decoration. A performance plugin that reports only its
 * wins leaves an operator unable to tell "the cache is working" from "the cache
 * found nothing to work on", and those two look identical in a latency graph.
 */
export interface CacheCoverage {
  /** Adapters handed to the plugin by either seam, across all passes. */
  readonly adaptersSeen: number
  /** Of those, the ones holding an index this plugin could reach. */
  readonly adaptersWithoutIndex: number
  /** Discovery passes run (mount plus one per `llm/adapters-updated`). */
  readonly passes: number
  /** Indexes the plugin is retaining documents for. */
  readonly covered: readonly CoveredTarget[]
  /** Indexes found and deliberately left alone in `observe` mode. */
  readonly observed: readonly CoveredTarget[]
  /** Indexes found, in scope, and not covered, with the reason. */
  readonly skipped: readonly SkippedTarget[]
  /** Things this plugin structurally cannot see, stated on every report. */
  readonly notCovered: readonly string[]
}

/** The read-only view `mode: 'observe'` and the tests both use. */
export interface CacheSnapshot {
  readonly mode: CacheMode
  readonly counters: MemoCounters
  readonly coverage: CacheCoverage
  readonly settings: MemoSettings
}

/** The service this plugin provides. */
export interface UploadIndexCacheService {
  /** Counters and coverage, as of now. */
  snapshot(): CacheSnapshot
  /** Zero the counters and drop every retained document. */
  reset(): void
}

/** What the plugin holds for one covered index. */
interface Coverage {
  readonly index: IndexLike
  readonly path: string
  /**
   * The seam that reaches this adapter, upgradable by design.
   *
   * The registry publishes `llm/adapters-updated` *during* the host's own
   * `registerAdapter` call (its `commitRoutes` mutates and announces in one
   * synchronous section), so a discovery pass almost always labels an adapter
   * through the map before the wrapper that handed it to us gets to name it. The
   * label is upgraded rather than left to depend on listener order: "the host
   * handed us this adapter" is a fact about the deployment, and it must not be
   * reported as absent because an event arrived first.
   */
  source: TargetSource
  /** Whether `load` was an own property before patching, so removal restores the same shape. */
  readonly ownLoad: boolean
  /** The method captured before patching. */
  readonly original: LoadFunction
}

/** One index the plugin saw and deliberately left alone, in `observe` mode. */
interface Observed {
  readonly path: string
  /** Upgradable for the same reason {@link Coverage.source} is. */
  source: TargetSource
}

/**
 * The statements the plugin makes about its own blind spots.
 *
 * Kept as a function of the settings rather than a constant so the `onlyPaths`
 * filter is named when it is doing something, and written in the report's own
 * voice so a reader is not left to infer the boundary from an absence.
 * @param settings - the resolved configuration.
 * @returns the lines the report carries.
 */
function blindSpots(settings: Settings): string[] {
  const lines = [
    'An upload index that no registered adapter owns is invisible to this plugin: it finds live instances through the LLM registry.',
    'Coverage is per instance. An index constructed after a discovery pass is covered by the next `llm/adapters-updated` event, not immediately.',
  ]
  if (settings.onlyPaths.length > 0) {
    lines.push(`Only indexes under ${settings.onlyPaths.map(prefix => `"${prefix}"`).join(', ')} are in scope, by configuration.`)
  }
  if (settings.maxBytes > 0) {
    lines.push(`Indexes larger than ${settings.maxBytes} bytes are read the ordinary way; they are reported as bypassed, not covered.`)
  }
  return lines
}

/**
 * Mount the plugin.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the default lives here. It cannot live in an exported `Config`:
 * Cordis reads `Config['~standard'].validate` off a plugin's `Config`, and a
 * plain defaults object has no such property, so naming one there makes the mount
 * throw before this function is called.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return
  const memo = new LoadMemo(settings, Date.now, error => {
    ctx.logger.warn(`upload-index-cache: bookkeeping failed, serving the ordinary read: ${String(error)}`)
  })
  const coverages = new Map<IndexLike, Coverage>()
  const observed = new Map<IndexLike, Observed>()
  const skipped: SkippedTarget[] = []
  const skippedKeys = new Set<string>()
  let adaptersSeen = 0
  let adaptersWithoutIndex = 0
  let passes = 0

  const report = (message: string): void => {
    if (settings.report) ctx.logger.info(`upload-index-cache: ${message}`)
  }

  /** Record something the plugin found and deliberately did not cover. */
  const skip = (path: string, reason: string): void => {
    const key = `${path}\u0000${reason}`
    if (skippedKeys.has(key)) return
    skippedKeys.add(key)
    skipped.push({ path, reason })
  }

  /** Counters plus coverage, snapshotted so a caller cannot mutate the live state. */
  const snapshot = (): CacheSnapshot => ({
    mode: settings.mode,
    counters: { ...memo.counters },
    coverage: {
      adaptersSeen,
      adaptersWithoutIndex,
      passes,
      covered: [...coverages.values()].map(entry => ({ path: entry.path, source: entry.source })),
      observed: [...observed.values()].map(entry => ({ ...entry })),
      skipped: skipped.map(entry => ({ ...entry })),
      notCovered: blindSpots(settings),
    },
    settings: { maxBytes: settings.maxBytes, maxAgeMs: settings.maxAgeMs },
  })

  /**
   * Cover one index, once.
   *
   * `observe` stops before the assignment, so the counters measure the
   * deployment as it is rather than as it would be — which is the only reading
   * that can justify turning the cache on. The targets it saw are reported under
   * `observed`, not under `covered`: a report that listed an unpatched index as
   * covered would be the exact silent-cache failure this plugin exists to avoid.
   * @param target - an index and the seam that found it.
   */
  const cover = (target: IndexTarget): void => {
    const held = coverages.get(target.index)
    const seenBefore = observed.get(target.index)
    if (held !== undefined || seenBefore !== undefined) {
      // Already known. The one thing worth doing again is upgrading the seam:
      // see `Coverage.source`.
      if (target.source === 'register-adapter') {
        if (held !== undefined) held.source = target.source
        else if (seenBefore !== undefined) seenBefore.source = target.source
      }
      return
    }
    const index = target.index
    if (settings.mode === 'observe') {
      observed.set(index, { path: target.path, source: target.source })
      return
    }
    const original = index.load
    const ownLoad = Object.hasOwn(index, 'load')
    try {
      index.load = memo.wrap(original)
    } catch (error: unknown) {
      // A frozen instance, or a proxy that refuses the write. Reported rather
      // than swallowed: "not covered" is a fact an operator needs.
      skip(target.path, `load could not be replaced: ${String(error)}`)
      ctx.logger.warn(`upload-index-cache: not covering ${target.path}: ${String(error)}`)
      return
    }
    coverages.set(index, { index, path: target.path, source: target.source, ownLoad, original })
    report(`now retaining the parsed document for ${target.path} (found via ${target.source})`)
  }

  /** Take one adapter from either seam, and cover the index it holds. */
  const seen = (adapter: unknown, source: TargetSource): void => {
    adaptersSeen += 1
    const index = indexOfAdapter(adapter)
    if (index === undefined) {
      adaptersWithoutIndex += 1
      return
    }
    // The filter is applied on this seam too. A host that hands the plugin an
    // adapter is not a reason to ignore the operator's `onlyPaths`.
    if (!inScope(index.path, settings.onlyPaths)) {
      skip(index.path, 'out of scope: the configured onlyPaths prefixes do not cover it')
      return
    }
    cover({ path: index.path, index, source })
  }

  const llm: unknown = ctx.get('llm')

  ctx.effect(() => {
    // Seam 1: the public method the deepseek host calls with the adapter it just
    // built. Wrapping it means the plugin never has to guess how to reach an
    // index — the host hands it one.
    const dispose: Array<() => void> = []
    const registry = (llm as { registerAdapter?: unknown } | undefined)?.registerAdapter
    if (typeof registry === 'function') {
      const originalRegistry = registry as (this: unknown, ...args: unknown[]) => unknown
      const ownRegistry = Object.hasOwn(llm as object, 'registerAdapter')
      const patched = function (this: unknown, ...args: unknown[]): unknown {
        const result = originalRegistry.apply(this, args)
        try {
          seen(args[1], 'register-adapter')
        } catch (error: unknown) {
          ctx.logger.warn(`upload-index-cache: could not cover an adapter at registration: ${String(error)}`)
        }
        return result
      }
      // Through `ctx.get`, whose value is a traceable proxy over the service
      // instance: the assignment lands on the instance, so every later reader
      // (including the deepseek host) calls the wrapper.
      ;(llm as { registerAdapter: unknown }).registerAdapter = patched
      dispose.push(() => {
        // Restore the shape as well as the behaviour. The registry's method is
        // normally inherited, so leaving an own property behind would be a
        // visible change to an object this plugin does not own — harmless in
        // behaviour, and still the kind of residue a mounted/unmounted pair is
        // supposed to leave none of.
        if (ownRegistry) (llm as { registerAdapter: unknown }).registerAdapter = originalRegistry
        else delete (llm as { registerAdapter?: unknown }).registerAdapter
      })
    } else {
      skip('(registry)', 'ctx.llm.registerAdapter was not callable, so adapters registered after mount are only seen on the next discovery pass')
    }

    // Seam 2 + the retry: the registry's own adapter map, re-read whenever it
    // announces a change. This is what covers adapters that were registered
    // before the plugin mounted.
    //
    // The map is asked for *every* adapter and the path filter is applied here,
    // with the same `inScope` predicate `discover` uses, so an index the
    // configuration excludes is reported as excluded rather than silently
    // absent — a filter is a decision, and a coverage report that cannot show
    // one is a report that cannot show what the operator turned off.
    const pass = (): void => {
      passes += 1
      try {
        for (const target of discover(llm, [])) {
          if (!inScope(target.path, settings.onlyPaths)) {
            skip(target.path, 'out of scope: the configured onlyPaths prefixes do not cover it')
            continue
          }
          cover(target)
        }
      } catch (error: unknown) {
        ctx.logger.warn(`upload-index-cache: discovery pass failed: ${String(error)}`)
      }
    }
    pass()
    dispose.push(ctx.on('llm/adapters-updated', () => {
      pass()
    }))

    report(`mounted in ${settings.mode} mode; ${coverages.size} index(es) covered, ${observed.size} observed, ${adaptersSeen} adapter(s) seen`)

    return () => {
      for (const entry of coverages.values()) {
        try {
          if (entry.ownLoad) entry.index.load = entry.original
          else delete (entry.index as { load?: unknown }).load
        } catch (error: unknown) {
          ctx.logger.warn(`upload-index-cache: could not restore ${entry.path}: ${String(error)}`)
        }
      }
      coverages.clear()
      for (const off of dispose) off()
    }
  }, 'upload-index-cache: retain the parsed upload index across lookups')

  ctx.provide('uploadIndexCache', {
    snapshot,
    reset: () => {
      memo.reset()
      for (const key of Object.keys(memo.counters) as Array<keyof MemoCounters>) memo.counters[key] = 0
    },
  } satisfies UploadIndexCacheService)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * `Config: defaultConfig` used to be exported here. `defaultConfig` is a plain
 * object rather than a schema, so the lookup found no `~standard` and every mount
 * of the installed package died with `TypeError: Cannot read properties of
 * undefined (reading 'validate')` before `apply` ran. The defaults reach a mount
 * through `apply(ctx, config = {})` instead, and the convention in this
 * repository's own packages is a real schema (`export const Config = z.object(…)`)
 * or no `Config` at all — never a plain object.
 */
export default { name, inject, apply }
