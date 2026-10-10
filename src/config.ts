/**
 * Configuration, normalized once at mount.
 *
 * The knobs are the questions an operator actually asks about a plugin that
 * changes how often a file is read: *is it on* (`mode`), *how much may it hold*
 * (`maxBytes`), *when does it distrust the filesystem* (`maxAgeMs`), *which
 * indexes* (`onlyPaths`), and *what does it say it did* (`report`).
 *
 * `maxBytes` defaults to 8 MiB because that is the ceiling the report's own
 * patch chose, and because an index that has grown past it is a deployment
 * whose index deserves attention rather than one more silent cache. `maxAgeMs`
 * defaults to `0` — no age bound — because the inode identity is the precise
 * signal and a second, blunter trigger only hides filesystem problems.
 *
 * `mode: 'observe'` installs the same discovery and the same counters but
 * patches nothing: it is how an operator answers "how often is this actually
 * being read in *my* deployment" before trusting the answer to a cache. That
 * measurement is the whole reason this plugin is not a one-line monkey patch —
 * see the README.
 *
 * @module @argszero/dsh-upload-index-cache/config
 */

/** What the plugin does once it has found an index. */
export type CacheMode = 'cache' | 'observe' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /**
   * `cache` (default) retains the parsed document and re-reads it only when the
   * file's identity changes. `observe` counts lookups without patching anything,
   * so the read amplification can be measured before it is trusted. `off`
   * installs nothing at all.
   */
  readonly mode?: CacheMode
  /**
   * Index files larger than this are read the ordinary way, every time. `0`
   * removes the ceiling, which means an index of any size is retained.
   */
  readonly maxBytes?: number
  /**
   * Re-read a retained document once it is this many milliseconds old even when
   * the file's identity still matches. `0` (default) makes the identity the only
   * trigger.
   */
  readonly maxAgeMs?: number
  /**
   * Cover only indexes whose path starts with one of these prefixes. Empty
   * (default) covers every index the plugin can reach.
   */
  readonly onlyPaths?: readonly string[]
  /** Log the coverage line at mount and on every discovery pass. */
  readonly report?: boolean
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: CacheMode
  readonly maxBytes: number
  readonly maxAgeMs: number
  readonly onlyPaths: readonly string[]
  readonly report: boolean
}

/**
 * The reference defaults: the value behind every absent knob.
 *
 * A plain object rather than a schema, by design: every value is a primitive or
 * a list of primitives, and a plugin that fails to mount because a configuration
 * library disagreed with the operator would be a worse trade than one that reads
 * what it was given and falls back per field.
 *
 * That leniency is exactly why this object must **not** be exported as the
 * plugin's `Config`. Cordis validates a mounted plugin's `Config` through
 * `Config['~standard'].validate`, and a plain object has no `~standard`, so
 * naming it `Config` is what made every mount of this package throw before
 * `apply` ran. The entry point exports `{ name, inject, apply }` with no
 * `Config`, and the defaults arrive through `apply(ctx, config = {})` — where the
 * per-field fallback above is applied.
 */
export const defaultConfig: Required<Config> = {
  mode: 'cache',
  maxBytes: 8 * 1024 * 1024,
  maxAgeMs: 0,
  onlyPaths: [],
  report: true,
}

/** Read a non-negative integer, falling back for anything that is not one. */
function count(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/** Read a boolean, falling back for anything that is not one. */
function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read a list of non-empty strings, dropping anything else.
 *
 * Entries are bounded because they are matched against every index path, and an
 * entry of unbounded length is a comparison that costs more than the check it
 * belongs to.
 * @param value - the configured list.
 * @returns the usable entries, trimmed and bounded.
 */
function prefixes(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim().slice(0, 1024))
}

/**
 * Resolve a user configuration into the settings the plugin runs with.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  return {
    mode: config.mode === 'off' || config.mode === 'observe' ? config.mode : 'cache',
    maxBytes: count(config.maxBytes, defaultConfig.maxBytes),
    maxAgeMs: count(config.maxAgeMs, defaultConfig.maxAgeMs),
    onlyPaths: prefixes(config.onlyPaths),
    report: flag(config.report, defaultConfig.report),
  }
}
