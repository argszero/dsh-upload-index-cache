/**
 * Finding the live upload indexes, without importing a second copy of the
 * package that owns them.
 *
 * ## Why this is the hard half
 *
 * `DeepSeekUploadIndex` is not a cordis service. `registerDeepSeekProvider()`
 * (`packages/llm/llm-deepseek/src/host.ts:23`) never passes `resolveFiles`, so
 * `DeepSeekAdapter`'s constructor does `this.files = new DeepSeekFileStore()`
 * (`adapter.ts:29`) and that store's constructor does
 * `new DeepSeekUploadIndex()` — a private field of a private field of the
 * adapter. There is no `ctx.get('...')` that reaches it, and no public accessor
 * on `LlmRuntime` that returns a registered adapter (`listProviders()` returns
 * detached `{id, name}` metadata only).
 *
 * And the package must **not** be imported to reach its class: a `profile`
 * deployment is exactly the layout in which a second copy of a harness package
 * can be materialized, and patching *that* copy's prototype would be a plugin
 * that reports success while changing nothing. Every target here is therefore
 * discovered **from a live object**, so the method that gets patched is provably
 * the one the running code calls.
 *
 * ## The two ways in, in order
 *
 * 1. **`llm.registerAdapter` (public).** A waterfall-free method that the
 *    deepseek host calls with the adapter it just built, so wrapping it yields
 *    the real adapter object. This is the primary seam, and it is public API.
 * 2. **the registry's adapter map (private).** `LlmRuntime` keeps
 *    `private adapters = new Map<string, AdapterRegistration>()`; its field name
 *    survives compilation, so `ctx.llm.adapters` is readable. This exists
 *    because seam 1 only sees adapters registered *after* mount, and a plugin
 *    mounted into a running profile must cover what is already there. It is
 *    guarded (`instanceof Map`, per-entry shape checks) and it is described as
 *    what it is: reading a private field, best-effort.
 *
 * Both are re-run whenever `llm/adapters-updated` fires, which covers adapters
 * whose routes are replaced as well as adapters this plugin was not mounted in
 * time to see. A discovery that finds nothing is **not** an error: at mount time
 * in a fresh process there may be no adapter yet, and the event will say when
 * there is one.
 *
 * @module @argszero/dsh-upload-index-cache/discover
 */

import { asIndexLike } from './cache.ts'
import type { IndexLike } from './cache.ts'

/**
 * Which way in reached an adapter, reported rather than implied.
 *
 * `register-adapter` means the host handed the plugin the adapter in its own
 * `llm.registerAdapter` call, which is something only an adapter registered
 * *after* mount can be. `adapter-registry` means the plugin found it by reading
 * the registry's adapter map, which is also the only way an adapter registered
 * *before* mount is reached at all. Both are reported, because an operator
 * debugging "why is my provider not covered" needs to know which seam went
 * quiet.
 */
export type TargetSource = 'register-adapter' | 'adapter-registry'

/** One live upload index this plugin can cover. */
export interface IndexTarget {
  /** The index's own absolute path, used for the `onlyPaths` filter and reports. */
  readonly path: string
  /** The live instance — the object whose own `load` will be patched. */
  readonly index: IndexLike
  /** How it was found. */
  readonly source: TargetSource
}

/**
 * Walk `adapter` → `.files` → `.index` and accept the result if it looks like an
 * index. Both hops are private fields of the deepseek package, and both are
 * guarded here rather than assumed.
 * @param adapter - a candidate adapter object.
 * @returns the index it owns, or `undefined`.
 */
export function indexOfAdapter(adapter: unknown): IndexLike | undefined {
  if (typeof adapter !== 'object' || adapter === null) return undefined
  const store = (adapter as { files?: unknown }).files
  if (typeof store !== 'object' || store === null) return undefined
  return asIndexLike((store as { index?: unknown }).index)
}

/**
 * Read the registry's adapter map.
 *
 * A private field, so every step is checked and an unexpected shape yields an
 * empty list rather than a throw — a plugin that cannot find its target must say
 * so, not take the deployment down looking.
 * @param llm - the value of `ctx.llm`.
 * @returns the adapters it holds, in registration order.
 */
export function adaptersOf(llm: unknown): unknown[] {
  if (typeof llm !== 'object' || llm === null) return []
  const registry = (llm as { adapters?: unknown }).adapters
  if (!(registry instanceof Map)) return []
  const adapters: unknown[] = []
  for (const registration of registry.values()) {
    if (typeof registration !== 'object' || registration === null) continue
    const adapter = (registration as { adapter?: unknown }).adapter
    if (adapter !== undefined) adapters.push(adapter)
  }
  return adapters
}

/**
 * Whether a path is in scope for the configured filter.
 * @param path - the index path.
 * @param onlyPaths - configured prefixes; empty means everything is in scope.
 * @returns `true` when the index should be covered.
 */
export function inScope(path: string, onlyPaths: readonly string[]): boolean {
  return onlyPaths.length === 0 || onlyPaths.some(prefix => path.startsWith(prefix))
}

/**
 * Every index reachable right now, deduplicated by identity.
 *
 * Deduplication is by object identity rather than by path: the same instance can
 * be reached through both seams, and it must be patched once. Two *different*
 * instances at one path are both covered — that is the honest outcome, and the
 * memo keys on the instance for exactly this reason.
 *
 * A caller that needs to *report* an exclusion passes `[]` here and applies
 * {@link inScope} itself; the plugin does that, so an index the configuration
 * left out can be named instead of leaving an unexplained hole in the report.
 * @param llm - the value of `ctx.llm`, or `undefined` when the plugin has none.
 * @param onlyPaths - configured path prefixes; empty means everything is in scope.
 * @returns the targets, each carrying the seam that found it.
 */
export function discover(llm: unknown, onlyPaths: readonly string[]): IndexTarget[] {
  const targets: IndexTarget[] = []
  const seen = new Set<IndexLike>()
  const add = (adapter: unknown, source: TargetSource): void => {
    const index = indexOfAdapter(adapter)
    if (index === undefined || seen.has(index)) return
    if (!inScope(index.path, onlyPaths)) return
    seen.add(index)
    targets.push({ path: index.path, index, source })
  }
  for (const adapter of adaptersOf(llm)) add(adapter, 'adapter-registry')
  return targets
}
