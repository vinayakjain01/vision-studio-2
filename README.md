# Vision Studio

High-accuracy fashion product image processing. Import a folder of photographs,
let a deterministic vision engine locate the subject, and render consistent
creatives by describing *where landmarks should sit* rather than how to resize.

Standalone by design: no Shopify, no Meta, no OAuth, no catalog sync, no hosted
database, no media CDN. It runs on a laptop against a folder on disk.

---

## What makes this different from "resize and crop"

A conventional template says *scale the photo to 80% and centre it*. Run that
over a real catalog and every image is framed differently, because the model
stands at a different distance in each one.

A Vision Studio template says:

> `head_top` sits **8%** from the top.
> `head_top → feet` spans **84%** of the canvas height.
> `subject_center` sits at **50%** horizontally.

From those three statements exactly one crop rectangle follows, and the solver
derives it per photo. Two images shot at different distances produce different
crops and **identical output framing**.

Everything the engine finds is a measurement, not a guess, and everything it
cannot measure is reported as unknown rather than filled in.

---

## Quick start

```bash
npm install
npm run setup        # applies the schema and downloads ~220 MB of ONNX weights
npm run dev          # http://localhost:3000
```

Then, in the app: **Import** a folder → wait for analysis → build a **Template**
→ add a **Rule** → **Generate**.

`npm run setup` is `npm run db:migrate && npm run models:fetch`. Both are
idempotent and safe to re-run.

### Requirements

* Node 20.11+
* ~4 GB free RAM (each vision worker holds ~700 MB resident)
* ~250 MB disk for model weights, plus whatever the imported originals need

No `.env` file is required — every setting has a working default. Copy
`.env.example` to `.env.local` only to override.

---

## The seven phases

| Phase | What it does | Where it lives |
|---|---|---|
| **1 — Folder import** | Recursive directory upload, EXIF and dimension extraction, content-addressed dedup, folder→product grouping | `src/import/`, `src/app/import/` |
| **2 — Vision Engine** | Person detection, pose, face landmarks, human matting, garment parsing → reusable metadata | `src/vision/` |
| **3 — Template builder** | Landmark-based framing controls with a fallback chain, plus a layer stack | `src/components/builder/`, `src/framing/` |
| **4 — Live preview** | Solves framing in the browser on every control change, no server round trip | `src/components/preview/` |
| **5 — Rules engine** | Maps folders, categories, imports or detected shot type to templates | `src/rules/` |
| **6 — Generation engine** | SQLite-backed queue, worker-process pool, compositor, progress and retry | `src/jobs/`, `src/render/`, `src/services/` |
| **7 — Vision Debug** | Landmarks, masks, crop boxes, confidences, before/after on the product page | `src/components/vision/` |

---

## The Vision Engine

Four ONNX models run locally on CPU. No network calls, no API keys, no sampling
— the same bytes always produce the same output.

| Model | Purpose | Size | Licence |
|---|---|---|---|
| YOLOv8n-pose | Person boxes + 17 COCO keypoints | 13 MB | AGPL-3.0 |
| SCRFD-10G | Face boxes + 5 landmarks | 17 MB | InsightFace model-zoo terms |
| MODNet | Human alpha matte | 25 MB | Apache-2.0 |
| SegFormer-B2 (ATR) | Per-pixel garment parsing, 18 classes | 110 MB | MIT |

> **Licensing.** The pose model is AGPL-3.0 and the face model carries
> InsightFace's non-commercial research terms. Both are fine for evaluation and
> internal use; check them against your own distribution plans. `npm run
> models:fetch` prints every licence it installs. Swapping either model means
> editing one entry in `src/vision/model-registry.ts` and bumping
> `ENGINE_VERSION` — no other code changes.

### Output: 18 semantic anchors

`head_top`, `eye_line`, `chin`, `neck`, `shoulder_left/right/center`, `chest`,
`waist`, `hip_center`, `knee_center`, `ankle_center`, `feet`, `garment_top`,
`garment_hem`, `subject_center/top/bottom`.

Each carries a **confidence** and the **rule that derived it**, so the debug
panel can always answer "why is the crop there". Anchors have several possible
sources with documented precedence — `head_top` prefers the parse's hair pixels,
then the matte's topmost row, then extrapolation from the face box — so a
template keeps working when one signal is missing, at a confidence the caller
can threshold on.

### Reuse in Craftify

`src/vision/` is a self-contained service. It imports no database, no HTTP
layer, no Next.js, and nothing from `src/app/`. Persistence enters through two
injected ports:

```ts
interface VisionCache { get(hash, version); set(metadata) }
interface MaskSink   { put(hash, kind, png, size) }
```

`src/services/vision-service.ts` implements those over SQLite and the local
filesystem — about 200 lines. Porting into Craftify means writing a sibling of
that one file against Supabase and Cloudinary. Nothing under `src/vision/`
changes.

---

## Architecture at a glance

```
Browser ──► API routes (src/app/api) ──► services ──► SQLite + filesystem
                                            │
                                            └─► jobs table ──► worker pool
                                                                (child processes)
                                                                    │
                                                    ┌───────────────┴───────────────┐
                                                    │                               │
                                              Vision Engine                    Compositor
                                            (src/vision, ONNX)          (src/render, skia)
                                                    │                               │
                                                    └──────► src/framing ◄──────────┘
                                                       solveFraming() — shared
```

`src/framing/solver.ts` is the only place a crop is computed. The browser
preview and the server compositor both call it, so a preview cannot disagree
with the output.

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Storage layout

Everything lives under `data/` (gitignored):

```
data/
  vision-studio.db                    SQLite (WAL)
  media/
    originals/<ab>/<cd>/<sha256>.jpg  never modified after write
    derived/<ab>/<cd>/<sha256>/       person_mask, garment_mask, cutout, preview
    creatives/<batchId>/<id>.jpg      rendered output
    assets/                           template logos and overlays
```

Originals are addressed by the sha256 of their bytes. Re-importing the same
folder is free and cannot duplicate storage, and any analysis already computed
for those bytes is reused immediately — a re-import finishes with zero
inference. This is why the import never re-encodes on the way in: that would
change the hash and defeat both.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run setup` | Migrate + fetch models |
| `npm run db:migrate` | Apply the schema (idempotent) |
| `npm run db:reset` | Drop tables and re-apply. **Media on disk is preserved** |
| `npm run models:fetch` | Download and sha256-verify model weights |
| `npm run models:verify` | Verify without downloading |
| `npm run worker` | Run the worker pool as a standalone process |
| `npm run typecheck` | `tsc --noEmit` |

### Diagnostics

```bash
# Analyse images and print anchors, garment data, and every framing preset
npx tsx scripts/smoke-vision.ts path/to/*.jpg

# Drive the whole pipeline through the real HTTP API
npx tsx scripts/smoke-e2e.ts http://localhost:3000 path/to/images
```

`smoke-vision.ts` is the fastest way to see whether a model or threshold change
altered anything. `smoke-e2e.ts` exercises import → analysis → template → rule →
batch → creative, including a determinism check that the same input renders
byte-identically.

---

## Performance

Measured on 12 cores / 16 GB, per image at 1280px analysis resolution:

| Stage | Time |
|---|---|
| Decode | ~250 ms |
| Pose | ~280 ms |
| Face | ~390 ms |
| Matting | ~450 ms |
| Garment parsing | ~2,000 ms |
| **Analysis total** | **~3.5 s** |
| Render (2048px, 2× supersampled) | ~400 ms |

Garment parsing dominates. It is the price of a real measurement: without it,
hem, sleeve length and neckline are not derivable from a silhouette, and an
earlier version that tried produced the same answer for every image.

Analysis is **once per unique image**, keyed by content hash and engine version,
so it is not paid again on re-import or re-render.

Worker counts are sized by resource profile, not core count — vision workers by
memory (~700 MB each), render workers by remaining cores, and ONNX intra-op
threads divided between them. Defaulting all of it to `cores - 1` oversubscribes
a 12-core machine several times over and collapses throughput. See
`defaultConcurrency()` in `src/config.ts`; override with `JOB_VISION_CONCURRENCY`,
`JOB_RENDER_CONCURRENCY` and `VISION_ORT_THREADS`.

---

## Known limitations

Stated plainly, because a system that reports its own uncertainty is more useful
than one that does not.

* **Garment analysis requires the parsing model.** Without it, `garment.type`,
  `hemY`, `sleeveLength` and `neckline` are `unknown` — not estimated from the
  silhouette. A matte cannot distinguish a bare forearm from a flesh-toned
  sleeve, or a hemline from the top of a boot.
* **`outerwear` is never returned.** ATR has no outerwear class, so a coat over a
  visible inner layer classifies as `upper_body`. Distinguishing them would be a
  guess.
* **Head extrapolation uses population averages.** `head_top` from a face box
  assumes the crown sits 0.43 box-heights above it. Correct to within a few
  percent of head height for upright adult poses, which is the only case it is
  used in. The constants are collected and explained in
  `src/vision/analysis/anchors.ts`.
* **Multi-person images follow one subject.** The largest, most central,
  most-complete detection wins, and `multiple_people` is raised as a warning.
* **`levelEyeLine` is declared but not implemented.** Rotating a photo to level
  a deliberate head tilt is destructive, so it is off by default and the
  compositor currently ignores it.
* **Template assets are referenced by storage key.** Copy logos into
  `data/media/assets/` manually; there is no asset upload UI yet.
* **No authentication.** Single-user, local-first. Do not expose the port to a
  network you do not control.
