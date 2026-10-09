/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * this harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and a
 * mutation that does not compile is reported as TYPEFAIL, because it never
 * reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped — one
 * distinction it exists to make, removed one edit at a time. They are not
 * "does the test file import the module": each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a promise the package makes
 * that nothing checks.
 *
 * The four arms this package would be *worthless* without are the identity key
 * losing the inode (a same-millisecond write becomes invisible — the whole
 * invalidation contract), `observe` installing the patch anyway (the mode that
 * exists so an operator can measure before trusting), the in-scope filter being
 * bypassed on the registration seam (an operator's exclusion silently ignored),
 * and the post-read identity check being dropped (an older generation retained
 * under a newer file's identity: a memo that serves a stale answer).
 *
 * ```sh
 * node scripts/inject-defects.mjs                   # every arm
 * node scripts/inject-defects.mjs --filter=identity  # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The invalidation contract. `writeFileAtomic` renames, so a write is
    // detected through the inode; without it, a write landing in the same
    // millisecond as the preceding read is served from the old document.
    name: 'identity: the key drops the inode, so an atomic write is invisible when size and mtime agree',
    file: 'src/cache.ts',
    edits: [['  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs',
      '  return left.size === right.size && left.mtimeMs === right.mtimeMs']],
  },
  {
    // "A missing file is a cacheable identity" is what makes the empty-index
    // case cheap. Without it the first `stat` throws and every lookup falls open.
    name: 'identity: an absent file is a stat failure rather than an identity',
    file: 'src/cache.ts',
    edits: [["    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { present: false }",
      "    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOTDIR') return { present: false }"]],
  },
  {
    // A candidate without a callable `load` is not an index. Accepting one makes
    // the wrapper patch a non-method and the memo answer nothing.
    name: 'asIndexLike: a candidate whose `load` is not a function is accepted as an index',
    file: 'src/cache.ts',
    edits: [["  if (typeof candidate.load !== 'function') return undefined", '  if (false) return undefined']],
  },
  {
    // The ceiling is why an index past it is read the ordinary way. Without it
    // the plugin retains a document of any size.
    name: 'maxBytes: the size ceiling no longer bypasses an oversized index',
    file: 'src/cache.ts',
    edits: [['      if (memo.settings.maxBytes > 0 && before.present && before.size > memo.settings.maxBytes) {',
      '      if (false) {']],
  },
  {
    // The age bound is the second trigger, and it is off by default. A memo that
    // ages out nothing ignores an operator's `maxAgeMs`.
    name: 'maxAgeMs: a retained document never ages out',
    file: 'src/cache.ts',
    edits: [['    if (this.settings.maxAgeMs <= 0) return false', '    if (this.settings.maxAgeMs >= 0) return false']],
  },
  {
    // The value above is a snapshot of *some* generation; retaining it under the
    // newer file's identity installs an older document after a newer write.
    name: 'identity: a document read across a concurrent write is retained under the newer identity',
    file: 'src/cache.ts',
    edits: [['      if (sameIdentity(before, after)) {', '      if (after.present || !after.present) {']],
  },
  {
    // Fail-open: a `stat` that threw is not the cache's to escalate. Throwing
    // turns a bookkeeping failure into a dead lookup.
    name: 'fail-open: a stat failure that is not ENOENT is escalated instead of serving the ordinary read',
    file: 'src/cache.ts',
    edits: [['        memo.counters.errors += 1\n        memo.failed(error)\n        return original.call(this)',
      '        memo.counters.errors += 1\n        memo.failed(error)\n        throw error']],
  },
  {
    // "Empty means everything" is the default filter. Inverted, the plugin
    // covers nothing until an operator names a prefix.
    name: 'inScope: an empty filter means nothing is in scope',
    file: 'src/discover.ts',
    edits: [['  return onlyPaths.length === 0 || onlyPaths.some(prefix => path.startsWith(prefix))',
      '  return onlyPaths.some(prefix => path.startsWith(prefix))']],
  },
  {
    // The registry read is the private seam, so it must survive a shape it did
    // not expect. Without the guard, an unexpected registry throws in the pass.
    name: 'registry: the Map guard is dropped and an unexpected registry reaches .values()',
    file: 'src/discover.ts',
    edits: [["  const registry = (llm as { adapters?: unknown }).adapters\n  if (!(registry instanceof Map)) return []",
      '  const registry = (llm as { adapters?: unknown }).adapters as Map<unknown, unknown>']],
  },
  {
    // Deduplication by instance is what keeps one index from being patched twice
    // when both seams reach it.
    name: 'discovery: the same instance reached twice is covered twice',
    file: 'src/discover.ts',
    edits: [['    if (index === undefined || seen.has(index)) return', '    if (index === undefined) return']],
  },
  {
    // `off` is the mode that installs nothing. Mounting anyway is the one thing
    // an operator asked not to happen.
    name: 'config: mode off mounts the plugin anyway',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'off') return", '  if (settings.mode === "off") void 0']],
  },
  {
    // `observe` counts without patching; it is how a deployment is measured
    // before the cache is trusted. Patch it and the measurement is gone.
    name: 'observe: the observe mode installs the patch it exists to postpone',
    file: 'src/index.ts',
    edits: [["    if (settings.mode === 'observe') {", '    if (settings.mode === "observe") { false } if (false) {']],
  },
  {
    // Unmounting has to give the instance back exactly as it was found —
    // that is the difference between a plugin and a permanent edit.
    name: 'unmount: the covered instance is not restored',
    file: 'src/index.ts',
    edits: [['          if (entry.ownLoad) entry.index.load = entry.original',
      '          if (false) entry.index.load = entry.original']],
  },
  {
    // The registration seam is the public one, and the operator's filter applies
    // to it exactly as it does to the discovery pass.
    name: 'onlyPaths: the registration seam ignores the configured filter',
    file: 'src/index.ts',
    // The filter is replaced with the empty prefix list: `inScope` then admits
    // every path. Spelled as a call rather than `if (false)` because TypeScript
    // marks a literal-false branch unreachable and stops narrowing inside it.
    edits: [['    if (!inScope(index.path, settings.onlyPaths)) {',
      '    if (!inScope(index.path, [])) {']],
  },
  {
    // The seam label is upgraded because the registry announces before the
    // wrapper is reached. Without the upgrade a public seam reads as private.
    name: 'seam: a registration seam seen through the map first is never upgraded',
    file: 'src/index.ts',
    // The literal is widened to `string` so the comparison is a runtime test:
    // written `if (false)` the branch is unreachable and the narrowing the two
    // assignments depend on is lost to the compiler.
    edits: [["    if (target.source === 'register-adapter') {",
      "    if ((target.source as string) === 'registration') {"]],
  },
  {
    // The report's whole claim is "these places are not covered". Emptying it
    // turns a disclosure into a silent success.
    name: 'report: the blind spots the plugin cannot close are no longer stated',
    file: 'src/index.ts',
    edits: [['      notCovered: blindSpots(settings),', '      notCovered: [],']],
  },
  {
    // The service is how a caller reads the counters this plugin exists to
    // publish. Providing it under another name is providing nothing.
    name: 'service: the snapshot service is provided under a name nobody reads',
    file: 'src/index.ts',
    edits: [["  ctx.provide('uploadIndexCache', {", "  ctx.provide('uploadIndexCacheValue', {"]],
  },
  {
    // The wrapper has to hand the host its own result back, or registration
    // stops working the moment the plugin is mounted.
    name: 'seam: the registration wrapper never names the adapter the host handed it',
    file: 'src/index.ts',
    edits: [["          seen(args[1], 'register-adapter')", '          void args[1]']],
  },
  {
    // Nonnegative integers only: `-1` and `1.5` are typos, not bounds.
    name: 'config: a byte count that is not a nonnegative integer is honoured',
    file: 'src/config.ts',
    edits: [['  return typeof value === \'number\' && Number.isInteger(value) && value >= 0 ? value : fallback',
      '  return typeof value === \'number\' ? value : fallback']],
  },
  {
    // The mode is one of three; anything else is the default, not a fourth mode.
    name: 'config: an unknown mode is kept instead of falling back to the default',
    file: 'src/config.ts',
    edits: [["    mode: config.mode === 'off' || config.mode === 'observe' ? config.mode : 'cache',", "    mode: config.mode ?? 'cache',"]],
  },
  {
    // Entries are matched against every index path, so each one is trimmed,
    // non-empty, and bounded. Without the trim a stray prefix matches nothing.
    name: 'config: a path prefix is used untrimmed and unbounded',
    file: 'src/config.ts',
    edits: [['    .filter((entry): entry is string => typeof entry === \'string\' && entry.trim() !== \'\')\n    .map(entry => entry.trim().slice(0, 1024))',
      '    .filter((entry): entry is string => typeof entry === \'string\')']],
  },
  {
    // `report` gates every log line this plugin writes.
    name: 'config: the report flag is forced on regardless of configuration',
    file: 'src/config.ts',
    edits: [['    report: flag(config.report, defaultConfig.report),', '    report: true,']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a reader can leave the
 * suite waiting on a lookup this package would otherwise bound, and a mutant
 * that never terminates is a mutant the suite cannot report on. It is killed
 * here and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
