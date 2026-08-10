nd # Vision Studio — Architecture

How the system is put together, and why each load-bearing decision was made that
way. Written for someone who has to change it.

---

## 1. Shape of the system

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                 │
│    pages (src/app/**)  ·  live preview  ·  Vision Debug overlay          │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ fetch
┌───────────────▼─────────────────────────────────────────────────────────┐
│  API routes (src/app/api/**)                                            │
│    thin: validate, call a service, return JSON. No business logic.       │
└───────────────┬─────────────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────────────┐
│  Services                                                                │
│    src/import/import-service.ts      folder → products + images          │
│    src/services/vision-service.ts    host adapter for the Vision Engine  │
│    src/services/generation-service.ts  plan → batch → progress           │
└───────┬──────────────────────────────────────────┬──────────────────────┘
        │                                          │
┌───────▼──────────────────┐          ┌────────────▼─────────────────────┐
│  Persistence              │          │  Job queue (jobs table)          │
│    SQLite (WAL)           │◄─────────┤    claim by conditional UPDATE   │
│    content-addressed FS   │          └────────────┬─────────────────────┘
└───────────────────────────┘                       │ spawn
                                        ┌───────────▼──────────────────────┐
                                        │  Worker pool (child processes)   │
                                        │    src/jobs/worker-entry.ts      │
                                        └───────┬──────────────┬───────────┘
                                                │              │
                                   ┌────────────▼───┐   ┌──────▼─────────────┐
                                   │ Vision Engine  │   │ Compositor         │
                                   │ src/vision/    │   │ src/render/        │
                                   │ ONNX Runtime   │   │ @napi-rs/canvas    │
                                   └────────┬───────┘   └──────┬─────────────┘
                                            │                  │
                                            └──► src/framing ◄──┘
                                              solveFraming()
                                        pure, isomorphic, single source
```

Three boundaries carry most of the design weight:

1. **`src/vision/` is portable.** It has no dependency on the database, the HTTP
   layer, Next.js, or this application's storage. It is intended to be lifted
   into Craftify unchanged.
2. **`src/framing/` is isomorphic and singular.** One crop implementation,
   called by both the browser preview and the server renderer.
3. **Workers are processes.** Native code faults cannot take the web server down.

---

## 2. Directory map

| Path | Responsibility | Notes |
|---|---|---|
| `src/vision/` | **The reusable core service.** Models, inference, anchors, garment, shot type, quality | Zero app dependencies. See §3 |
| `src/vision/providers/onnx/` | Model-specific pre/post-processing | The only place model tensor layouts are known |
| `src/vision/analysis/` | Interpretation shared by every provider | anchors · garment · shot-type · quality |
| `src/framing/` | Framing spec types and the solver | Pure; no Node, no DOM. See §4 |
| `src/templates/` | Template document types, layers, variables | Types and defaults only |
| `src/render/` | Server compositor | `@napi-rs/canvas`. Consumes `src/framing` |
| `src/import/` | Folder classification and ingestion | `file-rules.ts` is isomorphic — see §5 |
| `src/rules/` | Product → template resolution | Pure; the UI previews matches without a round trip |
| `src/jobs/` | Queue, worker pool, job handlers | See §6 |
| `src/db/` | Schema, migrations, repositories | Every SQL statement lives in `repositories.ts` |
| `src/storage/` | Content-addressed media store | Path-traversal guard lives here, not at call sites |
| `src/services/` | Host adapters and orchestration | Where the portable core meets this app. `inpaint-client.ts` calls the service below — see §6.6 |
| `src/app/` | Next.js routes and pages | Routes are thin |
| `src/components/` | UI | `preview/` and `vision/` are the substantial ones |
| `services/inpaint-service/` | **Standalone Python service.** SDXL inpainting for AI Extend | Separate deployable, own Dockerfile, own repo-relative README. Not part of the Next.js app or its build — see §6.6 and `docs/DEPLOY.md` |

---

## 3. The Vision Engine

### 3.1 Contract

```
bytes ──► decode ──► provider.analyze() ──► raw detections
                                               │
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                    ▼
                    subject select        garment          persist masks
                          │                    │                    │
                          └──────► anchors ◄───┘                    │
                                     │                              │
                                shot type ──► quality ◄─────────────┘
                                     │
                              VisionMetadata
```

The ordering is forced: anchors need the garment analysis (for `garment_top` /
`garment_hem`), the shot classifier needs the anchors (it asks which landmarks
are in frame), and the garment analyser needs the pose. Each stage consumes only
what earlier stages produced; nothing reaches back into raw model outputs.

### 3.2 Provider split

`VisionProvider` produces **only** boxes, keypoints, faces, a matte and a parse
map. Everything semantic — anchors, garment, shot type, quality — is computed
once in `src/vision/analysis/`, identically for every provider.

That split is what makes the engine swappable. A different model set, a GPU
backend or a hosted service only has to produce the same `RawVisionResult`, and
inherits every downstream behaviour unchanged.

### 3.3 Coordinate discipline

Every coordinate in `VisionMetadata` is in **source-image pixel space, EXIF
orientation applied**. Inference runs on a downscaled, letterboxed copy;
providers project results back before returning. Nothing outside
`src/vision/providers/` ever sees model-input coordinates.

The `Letterbox` record returned alongside each tensor is the sanctioned inverse.
Getting this wrong is the classic failure: detections land correctly on the raw
buffer and 90° wrong on screen, or every face is off by half the padding on
non-square sources. `preprocess.ts` has an `align` option precisely because YOLO
centres its padding and SCRFD does not.

### 3.4 Degradation

Only the pose model is required.

| Missing | Consequence |
|---|---|
| `face` | Head anchors extrapolate from pose keypoints at lower confidence |
| `segmentation` | No matte-derived anchors, no cutout |
| `parsing` | Garment type, hem, sleeves, neckline all report `unknown` |

Each is a documented reduced capability surfaced in `capabilities` and in the
quality warnings — never a silent substitution of a guess for a measurement.

### 3.5 Determinism

Same bytes + same models + same thresholds → byte-identical output. No sampling,
no temperature, no network, no wall-clock or random input to any decision. NMS
sorts with an index tie-break so two equally-scored detections always resolve the
same way; without that, `Array.prototype.sort` stability becomes an input to
which person is chosen as the subject.

`ENGINE_VERSION` captures the model set *and* the analysis code version. Cached
analyses are keyed by it, so a model change produces new rows rather than
silently reinterpreting old ones, and creatives rendered against a previous
version stay explainable.

### 3.6 Why garment parsing is a fourth model

An earlier implementation derived the garment by carving the head off the human
matte. It produced numbers and every one was circular: "garment top" was wherever
the carve cut, so the neckline estimate measured its own constant; "sleeve
length" compared silhouette width at the wrist against silhouette width at the
shoulder, which is torso width. Every test image returned `sleeves: long,
neckline: high` — the signature of a fabricated measurement.

A matte fundamentally cannot answer these questions. SegFormer/ATR labels
`upper_clothes`, `dress`, `skirt`, `pants`, `left_arm`, `right_arm` separately,
so "is the wrist covered by fabric or skin" is a direct read of labelled pixels.
It costs ~2 s per image. That is the price of the measurement being real.

---

## 4. Framing

### 4.1 The derivation

Canvas `W × H`. A crop `ch` source pixels tall maps onto `H` canvas pixels, so
magnification `u = H / ch`.

**Scale.** A landmark span of `d` source pixels should occupy fraction `s` of the
canvas height:

```
d · u = s · H   →   d · H / ch = s · H   →   ch = d / s
cw = ch · (W / H)
```

The canvas height cancels. Crop height depends only on the measured span and the
requested fraction — which is why one spec frames identically on a 1:1 tile and a
9:16 story.

**Vertical.** Anchor A at `y_A` lands at fraction `t` of canvas height:

```
cy = y_A − t · ch
```

**Horizontal.** Identically: `cx = x_B − t_h · cw`.

Three equations, one rectangle, no iteration.

### 4.2 Constraints

Applied afterwards as explicit adjustments, each recording what it changed:

| Order | Step | Trade-off |
|---|---|---|
| 1 | `maxUpscale` / `minUpscale` | Bounds magnification; breaks the span target |
| 2 | `keepInside` | Shifts first (preserves scale), grows only if the span genuinely does not fit |
| 3 | Overflow policy | `clamp` keeps scale, `shrink` keeps the anchor on target, `allow` lets the background fill |

A crop is never silently different from what the template asked for.
`FramingResult.violations` names every compromise and `placements` reports where
each anchor actually landed versus its target, in canvas pixels.

### 4.3 Strategy chains

A spec is an ordered list. The first strategy whose anchors were detected above
its confidence floor wins; the last must require no anchors so every image
resolves. The API rejects a document whose final strategy has requirements —
otherwise an undetected image has no way to render.

This is where consistency across a catalog actually comes from. The fallbacks are
chosen to target the same visual result, so a photo where the primary rule does
not apply still lands close, and `usedFallback` marks it for review.

### 4.4 One implementation

`solveFraming()` is pure TypeScript with no Node and no DOM. The browser preview
imports it directly; the compositor imports the same function. There is no second
implementation to keep in sync.

This is deliberate: Craftify carries two independent renderers — a DOM/CSS editor
and a `@napi-rs/canvas` compositor — that must be kept pixel-compatible by hand.
A preview that disagrees with the output is worse than no preview. Here, subject
placement is identical *by construction*. What CSS approximates is only layer
rasterisation — text metrics, blur, supersampled edges — and the builder offers a
real server render (`POST /api/render` with an inline document) for a final check.

---

## 5. Import

Files are grouped into products by **containing folder**, because that is how
fashion catalogs are laid out on disk:

```
AW25/dresses/red-midi/{01,02,03}.jpg   →  ONE product, three shots
```

A per-file rule would produce three products, which is almost never intended.
Files at the import root have no folder to group by, so each becomes its own
product. Within a product, files sort naturally so `look-2` precedes `look-10` —
plain lexicographic order would silently make the wrong shot primary.

`src/import/file-rules.ts` is **dependency-free and isomorphic**: the same
predicates classify files in the browser while scanning the picked directory and
on the server while validating what arrived. If those two ever diverge, the
client offers files the API rejects and the operator sees unexplained failures.

Uploads are batched by accumulated **bytes**, not file count. Bounding by count
sends 50 × 40 MB TIFFs in one request on a high-resolution catalog and 50 × 200 KB
JPEGs on a web-ready one — the first exceeds every body limit, the second wastes
round trips.

The `paths` form field is authoritative for both the relative path and the file
name. A multipart part's own filename is optional, and a client appending a Blob
rather than a File sends the literal `"blob"`, which would fail extension
classification for every image.

Originals are **never re-encoded or downscaled** on the way in. Vision precision
depends on full-resolution pixels, and a re-encode would change the content hash
that deduplication and analysis reuse depend on.

---

## 6. Jobs and workers

### 6.1 Why SQLite, not Redis

The database is already open, already durable, and already the source of truth.
A broker would introduce a second store that can disagree with the first — the
failure mode where a job exists in Redis but not in Postgres, or completes in one
and not the other. Craftify ends up running a BullMQ worker *and* a DB-poll loop
concurrently for exactly this reason.

### 6.2 Claiming

```sql
UPDATE jobs SET status = 'claimed' WHERE id = ? AND status = 'pending'
```

inside an IMMEDIATE transaction. The `AND status = 'pending'` is the entire
concurrency control: SQLite serialises writers, so of N workers racing for one
row exactly one sees `changes === 1`. No lease protocol, no lock table.

IMMEDIATE rather than DEFERRED because claiming is read-then-write; under
DEFERRED two workers both pass the read and one fails to upgrade, surfacing as
`SQLITE_BUSY` rather than a clean "someone else took it".

`attempts` increments at **claim** time, not on failure — a worker that dies
before reporting still burns an attempt, so a job that reliably crashes its
worker cannot loop forever.

### 6.3 Processes, not threads

Each worker drives four native addons: ONNX Runtime, sharp, better-sqlite3 and
skia. In a worker thread they share the web server's address space, so a native
fault takes the server down with it — which is what happened during development
(exit 139). Separate processes turn that into a non-zero exit the pool requeues
and respawns from, with a restart cap so a reproducible crash does not hot-loop.

A second, practical reason: `execArgv: ['--import', 'tsx']` is honoured at
process startup but ignored by worker threads, which fail with `Unknown file
extension ".ts"`. The worker runs its TypeScript source directly in both dev and
production, so there is no prod-only code path in the component doing the work.

`spawn` is used rather than `fork` because Turbopack treats `fork(<path>)` as a
module reference and tries to pull the worker into the route's module graph.
`spawn` takes an executable, and an `'ipc'` stdio slot provides the same
`child.send()` / `'message'` channel.

### 6.4 Sizing

Vision and render workers have different resource profiles and are sized
differently:

* **Vision** — ~700 MB resident each (165 MB of weights plus activations for a
  640² and a 512² graph). Bounded by **memory**: `min(4, (totalGB − 4))`.
* **Render** — tens of megabytes. Bounded by remaining **cores**.
* **ORT intra-op threads** — bounded per worker. Left at ORT's default each
  session spawns roughly one thread per core; four workers × four sessions × 12
  threads is ~200 native threads on 12 cores, and throughput collapses below the
  single-worker figure.

Sizing everything by `cores − 1`, the obvious default, puts eight vision
processes on a 12-core laptop and exhausts RAM. See `defaultConcurrency()` in
`src/config.ts`.

### 6.5 Batch accounting

Batch counters are **derived** from the jobs table on refresh, not incremented.
A worker crash between "job completed" and "counter incremented" would otherwise
leave a batch permanently short of its total and stuck at `running`.

Cancellation only touches `pending` and `claimed` rows — a `running` job is
inside an inference call and cannot be interrupted safely — so the render handler
re-checks `isBatchCancelled` immediately before writing output.

### 6.6 External GPU jobs (AI Extend)

`background_fill` is a third job kind, and it breaks the pattern above on
purpose: `vision` and `render` are CPU work sized by what THIS machine can
absorb (§6.4); `background_fill` is a network call to a GPU host that may not
even be this machine, and sizing it the same way would size a remote
resource by a local one.

Consequences of that:

* **Its own slot group.** `pool.ts` gives it `INPAINT_JOB_CONCURRENCY`
  dedicated worker slots, spawned the same way as vision/render slots
  (child process, `kinds: ['background_fill']`) but never folded into their
  groups as overflow — a vision slot picks up render work once analysis
  drains; nothing picks up `background_fill` work, and `background_fill`
  slots pick up nothing else.
* **A render job does not block waiting for one.** A render job for an
  `ai_extend` template checks whether the background it needs is already
  cached (`derivedKey` under the photo's own content-addressed tree — see §7).
  If not, it enqueues the `background_fill` job (if one isn't already
  in flight — `dedupeKey` scoped to photo+template) and defers ITSELF via
  `queue.defer()`: back to `pending`, `available_at` set a few seconds out,
  `attempts` left untouched. `claim()`'s `WHERE` clause skips rows whose
  `available_at` hasn't passed yet, so the render worker picks up other work
  in the meantime instead of idling on a job that isn't ready.
* **This is not `fail()`+retry.** A real failure and "still waiting" look
  different in the jobs table on purpose: `fail()` consumes an attempt every
  time; `defer()` doesn't, because waiting for a dependency that's actively
  running is not evidence anything is wrong. An `ai_extend` render job's
  `maxAttempts` is computed from `INPAINT_TIMEOUT_MS` at enqueue time (see
  `renderMaxAttempts` in `generation-service.ts`) specifically so it survives
  the slowest plausible wait — the default `maxAttempts` (3, exhausted in
  under 15 seconds against a 5-second poll) would give up long before even a
  healthy GPU generation, let alone a CPU-test-mode one, finished.
* **No fallback to a plain fill.** `src/services/inpaint-client.ts` never
  swallows a failure into a degraded-but-successful render — a Cloudinary-backed
  predecessor of this feature did exactly that, and the failure mode was
  invisible: a transient network blip quietly became a white background
  nobody noticed until they looked at the output. `background_fill` jobs fail
  loudly, land in the batch's own failure list, and are retryable the normal
  way once the service is reachable again.

The compositor (`src/render/compositor.ts`) does not call the inpaint service
itself — only `buildInpaintTarget()` (builds the padded photo + feathered
mask a `background_fill` job sends) and `computeOverflow()`/`inpaintCacheKind()`
(the cheap check a render job runs to decide whether it needs to wait at
all). `renderCreative()` only ever reads a byte buffer it's handed. Same
reasoning as §4.4 ("one framing implementation") applied to a second axis: a
compositor that reaches out to a GPU-hosted service on its own behalf is a
compositor that is no longer a fast, pure, synchronous-apart-from-decode
function — and every other job kind depends on it staying exactly that.

---

## 7. Data model

Keyed on two ideas:

**Content addressing.** Anything derived from pixels is keyed by `source_hash`
(sha256 of the original bytes), never by image id. Two products sharing identical
bytes share one analysis and one set of derived assets.

**Versioned analysis.** `vision_analyses` is unique on
`(source_hash, engine_version)`. A model upgrade produces a new row instead of
destroying the old one, so creatives rendered against the previous version stay
reproducible and the debug panel can compare versions.

| Table | Holds | Key relationships |
|---|---|---|
| `imports` | One folder-upload session, with counters | — |
| `products` | A grouping of images | `import_id`; unique `(import, folder_path, slug)` |
| `images` | One file: storage key, dimensions, EXIF, vision status | `product_id`; unique `(product_id, source_hash)` |
| `vision_analyses` | Full `VisionMetadata` JSON + denormalised scalars | unique `(source_hash, engine_version)` |
| `derived_assets` | Masks, cutouts, previews on disk | unique `(source_hash, kind)` |
| `templates` | `TemplateDocument` JSON | — |
| `rules` | One condition → one template | `template_id` |
| `batches` | Generation run, counters derived | — |
| `jobs` | Unified queue: vision, render, background_fill | partial unique index on live `dedupe_key`; `available_at` gates a deferred job's re-claim — see §6.6 |
| `creatives` | Rendered output **plus the resolved `FramingResult`** | unique `(image_id, template_id)` |

Storing the resolved framing on each creative is what lets the system explain a
creative long after the template has been edited.

---

## 8. Rules

Deliberately small: one condition, one template, no expression language, no
boolean composition. Those turn "which template did this product get, and why"
into a debugging exercise — a question asked constantly during a bulk run.

Ordering is **total**: priority, then computed specificity, then `created_at`,
then id. Specificity exists so that `folder = AW25/dresses` beats
`folder = AW25` without the operator hand-managing priority numbers. Every
comparison is deterministic, so two runs over the same data match identically.

`folder` + `starts_with` anchors on a path boundary, so `AW25` does not match
`AW25-archive` — a silent mis-route that is very hard to spot in a bulk run.

Vision-based rules (`shot_type`, `garment_type`) are **skipped**, not failed,
when analysis has not run. Falling through to a later rule would give the product
a different template than it will get once analysed, so the same catalog would
render differently depending on when generation started.

`planBatch()` resolves the whole catalog **without queuing anything**, so the
operator sees the template split and the unmatched count before committing. The
mistake worth catching is a rule set covering 300 of 4,000 products.

---

## 9. Rendering

`renderCreative()`: solve framing → background → layers below → subject → layers
above → downscale → encode.

* **Supersampling.** Everything draws at `supersample ×` output size and
  downscales once. Canvas does not anti-alias image edges or rotated layers; a
  1× render shows visible stair-stepping on any rotated badge.
* **Overflow-aware subject draw.** The crop may extend past the source. Canvas
  clips a negative source rect rather than padding it, so the intersection with
  the real image is computed and mapped to its proportional slice of the
  destination; the exposed remainder keeps whatever the background painted.
* **Blur without a blur primitive.** The blurred background downscales to a small
  offscreen canvas and draws back up with smoothing on — a genuine low-pass
  filter at a fraction of the cost of a separable convolution over a 4000px
  canvas.
* **Real word wrap.** `fillText` with a `maxWidth` argument *compresses*
  overflowing text rather than wrapping it, so long product names render
  squashed. Text is measured and broken explicitly, with letter-spacing included
  in the measurement — otherwise wrapping is computed for one width and drawn at
  another.
* **Fonts registered under their real family names.** Registering Noto Sans as
  `"Inter"` makes every text layer render at the wrong metrics while appearing
  to work.
* **AI Extend is a byte buffer, not a call.** When a template's background
  mode is `ai_extend`, `renderCreative()` accepts an optional
  `precomputedBackground` — bytes the caller (`handleRenderJob`, see §6.6)
  already generated via a `background_fill` job and read back from the
  derived-asset cache. The compositor decodes and draws it (a direct
  scale-to-fit — it was generated at exactly this template's canvas size, so
  there's no crop remapping to do); it never fetches, waits, or falls back to
  a plain fill on its own. If it's absent — the background-fill job hasn't
  produced one yet — the same clamped-stretch safety net every other
  background mode uses (`drawStretchedClamped`) applies instead, so a render
  is never blocked on a missing background at the compositor layer; the
  *decision* to wait for one happens one level up, in the job handler.
* **Layers can pin to landmarks.** `anchorTo` makes x/y an offset from where that
  anchor landed after framing, so a badge follows the model's shoulder across a
  catalog instead of sitting where it lands on her face every third photo. The
  preview and the compositor compute this the same way.

One broken layer — a missing asset, an unparseable colour — is skipped and
logged rather than abandoning the creative, so a single bad reference cannot
fail a 4,000-image run.

---

## 10. Verification

| Script | Covers |
|---|---|
| `scripts/smoke-vision.ts` | Analysis on real images: detections, anchors, garment, shot type, quality, plus every framing preset solved against the result |
| `scripts/smoke-e2e.ts` | The whole pipeline over HTTP: import → analysis → template → rule → plan → batch → creative, plus a byte-identity determinism check |

`smoke-vision.ts` is the fastest way to see whether a model or threshold change
altered anything — it needs no server, no database and no browser.

---

## 11. Extension points

**Swap a model.** Edit one entry in `src/vision/model-registry.ts` (URL, sha256,
size, licence), adjust the matching decoder in `src/vision/providers/onnx/`, and
bump `ENGINE_VERSION`. Existing analyses are retained under the old version.

**Add a vision provider.** Implement `VisionProvider` — produce
`RawVisionResult`. Anchors, garment analysis, shot type and quality are inherited
unchanged.

**Add an anchor.** Add to `ANCHOR_NAMES`, derive it in `analysis/anchors.ts` with
a documented source precedence and confidence, and it becomes available in the
framing controls, the debug overlay and layer pinning automatically.

**Add a framing strategy.** `FramingSpec.strategies` is data. Presets in
`src/framing/types.ts` are the starting points, not a closed set.

**Change the storage backend.** Implement `VisionCache` and `MaskSink`
(`src/vision/types.ts`) and construct the engine with them. That is the whole
port surface — see `src/services/vision-service.ts` for the local-filesystem
implementation.
