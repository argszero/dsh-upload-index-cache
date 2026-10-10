# @argszero/dsh-upload-index-cache

Retains the parsed DeepSeek upload index across lookups, so resolving the *n*-th
retained image in a request does not re-read and re-validate the whole file for
the *n*-th time.

One report, one measurement, one seam:
[#8814](https://github.com/deepseek-ai/deepseek-harness/discussions/8814) —
*"Repeated parsing of the DeepSeek Files index slows image-heavy sessions"*.

## The problem

Resolving a retained image to its DeepSeek file id costs a whole-index read and
re-validation, per image, per HTTP attempt:

```
adapter.ts:95         prepareFileIds(messages, versions, files)
images.ts:99            for each image reference: await files.resolve(...)
request-files.ts:116    resolve → DeepSeekFileStore.ensureUploaded
file-store.ts:188       ensureUploadedOnce → (:200) this.index.get(scope, variantId, now, margin)
upload-index.ts:149     get() → (:123) load() = readFile + parse + validate + linear .find
```

Measured on the published `0.2.1-alpha.1` bundle, index = 500 records /
201 433 bytes, Node 26.5.0 on macOS:

| stage | cost | share of one lookup |
|---|---|---|
| `readFile` | 31.67 ms | 13.5% |
| `JSON.parse` | 74.13 ms | 31.7% |
| per-record validation | 126.39 ms | 54.1% |
| linear `.find` | 1.53 ms | 0.7% |
| `stat` | 5.40 ms | 2.3% |
| **read + parse + validate** | **232.19 ms** | **99.3%** |

The `inflight` map in `DeepSeekFileStore` deduplicates only while an upload
promise has not settled, so it does nothing for a session whose images are
already uploaded — which is every request after the first. A request carrying
five retained images reads and validates that file five times.

## What this plugin does

It **memoizes `load()`** — the read and the parse — and re-reads only when the
file's identity changes:

- the identity is `(ino, size, mtimeMs)`, and the inode is the load-bearing
  field: `writeFileAtomic` (`@deepseek-ai/dsh-atomic-write`) renames a
  random-suffix sibling over the target, so every local write changes it. A key
  of modification time alone cannot promise to see a write that lands inside the
  same millisecond as a preceding read; the inode can, and does.
- a lookup `stat`s the file, and `stat`s it again before retaining a freshly
  parsed document. A read that raced a write is served — it is a consistent
  snapshot of *some* generation — but is **not** retained, so an older
  generation can never end up installed after a newer write finished.

It does **not** re-implement anything. The parser, the expiry rule, the file
lock, the atomic write, the v3 format and `get()`'s own linear scan are all
still core's, so the only thing a consumer can observe differently is how often
the file is read. That is also why the memo is correct for `commit()`, `remove()`
and `clear()` without knowing anything about them: all three build a new
`records` array with `filter()` and assign it to a local, so none of them
mutates the array the memo holds.

## Install

```sh
npm install @argszero/dsh-upload-index-cache@0.1.1
```

Then mount it. The package ships a bundle patch
(`dsh.bundle.patch: ./cordis.patch.yml`), so a deployment that follows the
harness's bundle convention gets it by adding one entry:

```yaml
- insert:
    - id: upload-index-cache
      name: '@argszero/dsh-upload-index-cache'
```

Mounting it directly works the same way and takes the same config:

```ts
import cache from '@argszero/dsh-upload-index-cache'

ctx.plugin(cache, { mode: 'observe' })   // measure before you cache
```

## Measuring before caching

`mode: 'observe'` installs the same discovery and the same counters and patches
**nothing**. It answers the question a cache otherwise answers by assumption —
"how often is this read in *my* deployment" — and it is meant to be run first.

```ts
const cache = ctx.get('uploadIndexCache')
cache.snapshot()
```

```jsonc
{
  "mode": "cache",
  "counters": { "lookups": 41, "hits": 35, "misses": 6, "bypassed": 0, "unstored": 0, "errors": 0 },
  "coverage": {
    "adaptersSeen": 1,
    "adaptersWithoutIndex": 0,
    "passes": 2,
    "covered": [{ "path": "…/llm-deepseek/files-v3.json", "source": "register-adapter" }],
    "observed": [],
    "skipped": [],
    "notCovered": [
      "An upload index that no registered adapter owns is invisible to this plugin: it finds live instances through the LLM registry.",
      "Coverage is per instance. An index constructed after a discovery pass is covered by the next `llm/adapters-updated` event, not immediately.",
      "Indexes larger than 8388608 bytes are read the ordinary way; they are reported as bypassed, not covered."
    ]
  },
  "settings": { "maxBytes": 8388608, "maxAgeMs": 0 }
}
```

`notCovered` is not decoration. A performance plugin that reports only its wins
leaves an operator unable to tell *"the cache is working"* from *"the cache found
nothing to work on"*, and those two look identical in a latency graph.

`cache.reset()` zeroes the counters and drops every retained document.

## Configuration

| option | default | meaning |
|---|---|---|
| `mode` | `'cache'` | `cache` retains the parsed document; `observe` counts the same lookups and patches nothing; `off` installs nothing |
| `maxBytes` | `8388608` (8 MiB) | index files larger than this are read the ordinary way, every time. `0` removes the ceiling |
| `maxAgeMs` | `0` | re-read a retained document once it is this old even when the identity still matches. `0` makes the identity the only trigger |
| `onlyPaths` | `[]` | cover only indexes whose path starts with one of these prefixes; empty covers every index the plugin can reach |
| `report` | `true` | log the mount line and each index it starts retaining |

The default ceiling is 8 MiB because an index that has grown past it is a
deployment whose index deserves attention rather than one more silent cache. The
default age bound is `0` because the inode identity is the precise signal and a
second, blunter trigger only hides filesystem problems.

## Where it attaches

`DeepSeekUploadIndex` is not a cordis service.
`registerDeepSeekProvider()` never passes `resolveFiles`, so
`DeepSeekAdapter`'s constructor does `this.files = new DeepSeekFileStore()`
(`adapter.ts:29`) and the store's constructor does `new DeepSeekUploadIndex()` —
a private field of a private field. There is no `ctx.get('…')` that reaches it,
and no public accessor that returns a registered adapter.

Two seams, in order:

1. **`llm.registerAdapter` (public).** A method the deepseek host calls with the
   adapter it just built, so wrapping it yields the real adapter object. This
   covers adapters registered *after* the plugin mounts, and it is the seam the
   coverage report names `register-adapter`.
2. **the registry's adapter map (private).** `LlmRuntime` keeps
   `adapters = new Map<string, AdapterRegistration>()`; the field name survives
   compilation, so it is readable. It is guarded (`instanceof Map`, per-entry
   shape checks) and it is what covers adapters registered *before* mount, and
   adapters whose routes are replaced. The report names it `adapter-registry`.

Both are re-run on every `llm/adapters-updated`. Because the registry publishes
that event *during* the host's own registration call, the map pass usually
reaches a new adapter before the public seam can name it; the reported seam is
upgraded rather than left to depend on listener order.

A discovery that finds nothing is not an error: at mount time in a fresh process
there may be no adapter yet, and the event says when there is one.

## Honest boundaries

- **An index no registered adapter owns is invisible to this plugin.** It finds
  live instances; it does not import the package to reach a class. Importing
  would be the wrong trade twice over: a `profile` deployment is exactly the
  layout in which a second copy of a harness package can be materialized, and
  patching *that* copy's prototype would be a plugin that reports success while
  changing nothing. `DeepSeekFileStore` built by hand, in a plugin or in a test,
  is not covered, and the report says so on every snapshot.
- **Callers of the memoized `load()` share one parsed object.** The unpatched
  method hands each caller a fresh parse; the memoized one hands back the object
  the first caller received, for as long as the file's identity is unchanged.
  Nothing in the deepseek package mutates what `load()` returns — `commit()`,
  `remove()` and `clear()` are the whole list of writers and all three are
  read-only over it — so this is unobservable today. It is still a real
  difference, it is the price of not paying the copy, and it is stated here
  rather than left to be discovered.
- **It saves a bounded fraction, not all of a lookup.** The linear `.find` in
  `get()` (0.7%) and the `stat` the memo performs (2.3%) are still paid on every
  lookup.
- **It is not a cache of the *remote* files.** It caches one local JSON file's
  parse. Expiry, quota handling and upload deduplication are untouched.
- **It fails open.** A `stat` or a bookkeeping error is logged once and the
  ordinary read happens. A cache whose bug froze every image lookup would be a
  worse failure than the cost it removes.

## Compatibility

The plugin patches the **instance's** `load()` and reads the instance's `path`,
so the API it depends on is the shape of `DeepSeekUploadIndex`, reached through
`@deepseek-ai/dsh-llm`'s registry. Peer ranges name the lines that were verified
by pinning every harness package to one line and running the suite against it
(`npm run test:probe-lines`), never inferred:

| peer | range |
|---|---|
| `@deepseek-ai/dsh-llm` | `>=0.1.7-rc.2 <0.2.0 \|\| >=0.2.0-rc.2 <0.2.1` |
| `@deepseek-ai/cordis` | `^4.0.2` |

Verified against the `0.1.7-rc.2` and `0.2.0-rc.2` lines. Each `||` segment's
floor is the build that was actually run, so the range and the probed set are the
same set — a line this plugin has not been run on is a line it does not claim.

The target of the patch, `@deepseek-ai/dsh-llm-deepseek`, is not a peer: the
plugin never imports it (doing so is the second-copy failure described above),
so declaring it would be a dependency the artifact does not have. Its
`DeepSeekUploadIndex` — an own `path` string and a `load()` returning
`{ formatVersion: 3, records }` — was checked by source inspection on the
`0.1.7-rc.2`, `0.2.0-rc.2` and `0.2.1-alpha.1` lines, and the suite runs against
the `0.2.0-rc.2` build.

`@deepseek-ai/dsh-llm` is a peer even though the plugin imports it only for the
`llm` service's type: `inject = ['llm']` makes the registry a hard requirement,
and mounting this plugin where there is no registry is not better than not
mounting it.

## Tests

```sh
npm test              # the full suite, against a real cordis context and a real DeepSeek adapter
npm run test:inject   # mutate the source one rule at a time; every arm must be caught
npm run test:probe-lines   # pin every harness package to one line and re-run the suite
```

The integration suite does not simulate the seam. It builds a real
`DeepSeekAdapter` holding a real `DeepSeekUploadIndex` at a temp path, registers
it on a real `LlmRuntime`, and proves the memo serves by making the index file
unreadable *after* the first lookup and watching the second one succeed anyway —
which is only possible if no read happened. The control arm runs the same
sequence with the plugin absent and watches the same second lookup fail with
`EACCES`.

## License

MIT
