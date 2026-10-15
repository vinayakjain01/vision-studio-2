# Issue triage — Phase 0

Status key per issue: **Confirmed** (verified directly against the source,
by me or cross-checked independently), **Strong hypothesis** (grounded in
specific code citations, not yet confirmed against a real before/after
fixture), **Needs fixture** (cannot say more without the actual
original/bad-output pair).

**Dependency note**: `LOCAL_ISSUE_DIR` (the folder of per-issue fixtures the
task spec references) has not been provided yet — only 5 images pasted
directly into chat are available, which are likely re-encoded/downscaled by
the chat client and unsuitable for the pixel-level, deterministic comparisons
Phases 2–3 require. Everything below is from reading the actual pipeline
code (three parallel investigations, cross-checked), not from running the
pipeline against real fixtures. Phase 1–3 acceptance testing is blocked on
that directory until it's provided.

Also gathered directly from the live production server (SSH access already
established for prior ops work this session), ahead of Phase 1's own
diagnostics:

**LIVE SETTINGS** — nothing overridden beyond secrets/auth; running on
`config.ts`'s own production-computed defaults for a 4 vCPU / 8 GB box:
`JOB_VISION_CONCURRENCY=1`, `JOB_RENDER_CONCURRENCY=1`, `VISION_ORT_THREADS=3`,
`CLOUDINARY_JOB_CONCURRENCY=4` (AI Extend global concurrency default),
`AI_EXTEND_PER_TENANT_CONCURRENCY=2`.

**SERVER EVIDENCE** — no OOM kills in the kernel log; all recorded pm2
restarts trace to deliberate deploys, not crash-looping. One real, if minor,
bug found while looking: 25 of the last ~5,940 jobs failed with `ENOENT`
reading image files that no longer exist on disk, all for one tenant — see
"Bonus finding" below.

---

## Issue 1 — Half-face images converted to full-face

**Status: Strong hypothesis, split across two layers.**

`src/vision/analysis/shot-type.ts` already has a deliberate, documented
defense against this exact bug: `headVisible` (computed at lines 266–287)
requires a real face detection or a pose keypoint clearing
`HEAD_KEYPOINT_FLOOR = 0.7` (line 110), and explicitly excludes
out-of-frame/extrapolated keypoints via `inFrame()` (lines 334–340,
with a documented example of a keypoint extrapolated to y = -67). So
**classification** of a half-face photo should correctly land on
`product_only`/`unknown`, not a shot type implying a full head.

The gap is one layer down: `src/vision/analysis/anchors.ts`'s `estimateHead`
still produces a `head_top` anchor **whenever a person is detected at all**
(its fallback #3, person-box proportions, lines 253–270), independent of
whether `headVisible` said the head is actually trustworthy.

**Confirmed** (checked directly, not just inferred): the solver's
`selectStrategy` (`src/framing/solver.ts:178–236`) *does* already filter
strategies by shot type (line 206:
`if (strategy.shotTypes.length > 0 && !strategy.shotTypes.includes(subject.shotType)) …`),
and `head_to_feet` is correctly restricted to `shotTypes: ['full_body']`
(`src/framing/types.ts:291`) — so a photo correctly classified as anything
*other* than `full_body` cannot reach that strategy at all. This is a real,
working guard, not a gap.

The actual remaining gap is one level more specific: `head_to_knees` is
restricted to `shotTypes: ['full_body', 'three_quarter', 'half_body']`
(`types.ts:300`) — and a `half_body` classification (torso + partial head
visible, correctly classified by shot-type's own rules) can still carry an
untrustworthy `head_top` anchor if the face itself is the part that's
cropped, since `half_body` classification doesn't itself assert
`headVisible`. `head_to_knees` uses `head_top` as its vertical anchor with
no independent check of whether that specific anchor is trustworthy — only
that the broader shot-type category is allowed to use this strategy at all.
Shot-type filtering and per-anchor trustworthiness are two different,
currently-independent checks, and only the first one exists today.

**Files**: `src/vision/analysis/shot-type.ts` (`headVisible`, lines 266–340),
`src/vision/analysis/anchors.ts` (`estimateHead`, lines 253–270),
`src/framing/solver.ts:178–236` (`selectStrategy` — shot-type filter
confirmed present; anchor-level trustworthiness filter confirmed absent).

**Fix plan** (Phase 2/3): make `head_top` (and any other head-derived
anchor) carry an explicit `cropped`/`untrustworthy` flag when `headVisible`
is false, and have the solver's required-anchor check reject a flagged
anchor the same way a missing one is rejected — falling through to the next
strategy or the backup rule, which preserves original framing. This is
exactly the "evidence-based anchors, `cropped` flag" mechanism the spec's
Phase 2.2/2.4 already calls for.

**Acceptance test**: a half-face fixture photo, run through the full
pipeline, must land on the backup rule (or a strategy with no head
requirement) and must not reposition/extend the crop toward where a full
head would be.

---

## Issue 2 — Full-length pants become short pants

**Status: Confirmed root cause** (verified directly against the source).

`shot-type.ts:46` sets `ANCHOR_FLOOR = 0.25` — the confidence floor used to
decide an ankle/foot anchor is "visible" for **classification** purposes.
`src/framing/types.ts:290` sets `minConfidence: 0.35` on the `head_to_feet`
strategy inside the `full_body_editorial` preset (the default preset,
`DEFAULT_FRAMING_PRESET`, line 450) — the confidence the **solver** requires
to actually use the `feet` anchor for a full-length crop.

A photo whose feet-anchor confidence lands between 0.25 and 0.35 is
correctly classified `full_body` (feet "visible" by the classifier's own
threshold), but the solver's `head_to_feet` strategy rejects that same
anchor as not confident enough and silently falls through to
`head_to_knees` (lines 297–300, same `minConfidence: 0.35`, spanning only
`head_top`→`knee_center`) — a real, intentional knee-length crop applied to
a photo whose full pants were actually visible and detected, just one
confidence tier short of what the crop strategy demands.

The `keepInside: ['head_top', 'feet', 'knee_center']` safety net
(`types.ts:282`) only protects an anchor that exists and is already in use
by the selected strategy — it does not reach back and reconsider a
rejected-for-low-confidence `feet` anchor.

**Files**: `src/vision/analysis/shot-type.ts:46` (`ANCHOR_FLOOR`),
`src/framing/types.ts:270–322` (`full_body_editorial` preset, both
strategies' `minConfidence`), `src/framing/solver.ts` (`selectStrategy`,
`enforceKeepInside`).

**Fix plan**: align the thresholds (raise `ANCHOR_FLOOR` for feet/ankle
specifically to 0.35, or lower the strategy's `minConfidence` to 0.25 — a
judgment call on which direction is actually correct, worth deciding with
real fixture data rather than arbitrarily), **or**, more robustly: have
`keepInside` apply before strategy selection narrows the anchor set, so a
feet anchor that exists with *any* nonzero confidence still gets protected
from being cropped out even if it wasn't confident enough to anchor the
strategy itself. The second option is more defensive and doesn't risk
quietly changing classification behavior elsewhere `ANCHOR_FLOOR` is used.

**Acceptance test**: a full-body fixture photo whose feet-anchor confidence
is known to sit in the 0.25–0.35 gap must render with the garment's full
visible length preserved, not cropped at the knee.

---

## Issue 3 — Black bars top/bottom

**Status: Strong hypothesis**, with the two most likely explanations from
the original spec actively **ruled out** by the code.

Ruled out: the canvas is never left transparent/uninitialized going into
export — every background mode (`solid`/`gradient`/`blur_extend`/
`edge_extend`/`ai_extend`) fills the entire canvas with an opaque color
*before* anything else is drawn (`src/render/compositor.ts:306–363`). Also
ruled out: a failed AI Extend fill does not fall back to a blank/unfilled
render — `src/jobs/worker.ts:171-226` explicitly `throw`s on a genuine
Cloudinary failure rather than rendering anything, matching the documented
contract at `src/templates/types.ts:59–62` ("never falls back to a plain
fill silently").

Most likely remaining explanation: a `solid`/`gradient` background whose
`background.color` is empty or invalid on a *specific template's* saved
data. `BackgroundSettings.color` has no runtime validation
(`src/templates/types.ts` — plain interface, no zod/schema check found).
Canvas2D's own behavior for an invalid `fillStyle` string is to silently
keep the *previous* value, which for a freshly created 2D context defaults
to black — so a corrupted/empty `color` on one template would paint the
whole canvas black, visible wherever the subject's placed rect doesn't
reach the canvas edge (i.e., exactly where letterboxing/padding normally
shows the intended background color).

**Files**: `src/render/compositor.ts:306–363` (`drawBackground`),
`src/templates/types.ts` (`BackgroundSettings`, `DEFAULT_BACKGROUND.color =
'#ffffff'`).

**Fix plan**: (1) validate `background.color` on template save (reject or
coerce an invalid/empty color rather than letting it reach the renderer),
(2) add the post-render check the spec's invariant I3 already asks for —
fail (not silently ship) a render whose edge rows/columns are uniformly
near-black when the source content is not. This is a backstop regardless of
root cause, and would have caught this independent of why it happened.
(3) Directly inspect the actual templates involved once fixtures/template
IDs are available — this is the one piece of real verification still
missing before calling this fully confirmed.

**Acceptance test**: no production template may have an empty/invalid
`background.color`; the post-render check fails any future render that
would otherwise ship with a near-black bar on a non-black source.

---

## Issue 4 — Slow (30 images ≈ 15 minutes)

**Status: Strong hypothesis, consistent with direct evidence from the live
server.**

`JOB_VISION_CONCURRENCY=1` and `JOB_RENDER_CONCURRENCY=1` are the live,
in-effect values on production right now (confirmed via SSH, not inferred)
— exactly the user's own stated hypothesis ("concurrency left at 1"). On a 4
vCPU/8 GB box, `config.ts`'s own production-sizing formula computes these
same values by design (see the P6 load-test report's recommended-settings
table) — this is not a misconfiguration so much as a deliberately
conservative default that was never revisited for this box's actual
headroom.

**Second confirmed contributor**: `src/jobs/queue.ts:54` —
`BACKGROUND_FILL_POLL_MS = 5_000`, a fixed 5-second poll/defer interval
whenever a render job is waiting on its AI Extend background fill
(`src/jobs/worker-entry.ts:205,223,268`). With `JOB_RENDER_CONCURRENCY=1`
and real AI Extend latency well above 5s (the mock provider built for the
P6 load test used a realistic 2–15s range), a batch with few images per
template can leave the single render worker doing nothing but
claim→check→defer→wait every 5 seconds for the full duration of each
fill, rather than being re-queued the instant the fill actually
completes — exactly the spec's own candidate hypothesis, now confirmed
rather than just suspected.

This still doesn't fully explain "30s/image" without knowing each stage's
actual share — Phase 1.2/1.3's diagnostics (per-stage timing logs,
`npm run diag`, the mocked-AI-Extend-latency reproduction) are the
correct way to get real numbers rather than guessing further. Remaining
candidates worth testing specifically: full images being sent to
Cloudinary rather than a resized version, and analysis running at full
resolution regardless of what's actually needed.

**Fix plan**: build the Phase 1.2 diagnostics first, then let the
reproduction's actual per-stage timeline decide which of the above (if
any) is the real bottleneck before touching concurrency defaults — raising
concurrency blindly on a shared box is exactly the mistake `config.ts`'s own
extensive comments already warn against.

**Acceptance test**: images/minute reported before and after, for analysis
alone, render without AI Extend, and render with AI Extend, against a
reproducible mocked-latency harness.

### Phase 1.3 — reproduction results (real data, not a guess)

`scripts/reproduce-issue4-slow-batch.ts` reproduces the full pipeline
(real ONNX vision analysis, real `sharp`/canvas render, Cloudinary's
generative-fill call mocked at a configurable realistic latency — see
`src/jobs/loadtest-mock-ai-extend.ts`) at the confirmed live settings
(`JOB_VISION_CONCURRENCY=1`, `JOB_RENDER_CONCURRENCY=1`,
`VISION_ORT_THREADS=3`, `CLOUDINARY_JOB_CONCURRENCY=4`,
`AI_EXTEND_PER_TENANT_CONCURRENCY=2`). 30 synthetic photos, AI Extend
latency sampled around a 12s centre (±40%, occasional 2x tail, ~8% 429
rate) — this run's full `[stage]` log and parsed breakdown are in
`docs/evidence/issue4-repro-30img-12s.log` and
`docs/evidence/issue4-repro-30img-12s-stage-breakdown.txt`.

| Phase | What it isolates | Result |
|---|---|---|
| A — vision analysis only | decode/pose/face/segmentation/parsing, concurrency=1 | 30 images in 56.9s → **31.6 img/min** |
| B — render, no AI Extend | pure composite + encode, no network wait at all | 30 images in 4.1s → **436 img/min** |
| C — render WITH AI Extend | the actual reported slow path | 30 images in 230.9s → **7.8 img/min** |

**Confirmed, evidence-based findings:**

1. **AI Extend wait is overwhelmingly the bottleneck, not vision or render
   themselves.** Render-without-AI-Extend (Phase B) is ~56x faster than
   render-with-AI-Extend (Phase C). Vision analysis (Phase A) is not
   fast but is not the reported problem either — 1.9s/image average,
   dominated by `vision:parsing` (segmentation post-processing, ~1.1s)
   not model inference.
2. **"Full-size image sent to the provider" is RULED OUT** — read
   directly from `src/services/cloudinary-service.ts:270-275`: the
   source photo is resized locally to its exact placed (canvas-relative)
   size *before* upload. Cloudinary never receives the original-resolution
   photo.
3. **"Render supersampling" is a real, previously-unflagged contributor
   to real-world (not mocked) latency.** `src/render/compositor.ts`'s
   AI-Extend background request is built at the RENDER SURFACE
   resolution — canvas × `config.render.supersample` (default 2) — not
   at the final output canvas size (default `RENDER_OUTPUT_MAX_DIM=2048`,
   so the generative-fill request is commonly asked to produce up to
   ~4096px per side, 4x the pixel area of what's actually needed in the
   final output. The code comment at `cloudinary-service.ts:238-249`
   explains this is deliberate (matching resolution avoids a visible
   seam between the sharp subject and a softer upscaled background) — so
   this is not a free fix, but it is a genuine, previously-undocumented
   reason real Cloudinary latency could run well above a generic
   12s estimate: our mock samples a flat latency regardless of requested
   canvas size, so this reproduction cannot quantify the real cost, only
   flag that the request is larger than it needs to be for latency
   purposes.
4. **The fixed 5s poll (`BACKGROUND_FILL_POLL_MS`) produces a very large
   number of defer/reclaim cycles** — 646 `defer:background_not_ready`
   + 551 `defer:ai_extend_busy` events across just 30 images (1,197
   total claim→defer round trips). Each cycle is cheap in isolation (the
   worker never blocks; it moves on to the next claimable job), but this
   is 1,197 extra SQLite writes (job claim + defer update) and queue
   contention events for a 30-image batch — real, measurable overhead,
   just not the dominant one at this batch size.
5. **`AI_EXTEND_PER_TENANT_CONCURRENCY=2` sets a hard floor**: 30 fills
   at ~12s each, 2 at a time, is a theoretical minimum of
   `ceil(30/2) × 12s = 180s` if slots are always kept full. The observed
   230.9s is close to that floor — the ~50s difference is poll-interval
   slack (fills don't line up perfectly on slot boundaries) plus the
   vision-completion prerequisite overlapping the batch start.

**The open gap, stated plainly**: 7.8 img/min (7.7s/image) in this
controlled single-tenant reproduction is **~4x faster** than the reported
"30 images / 15 minutes" (~30s/image). This reproduction does **not**
fully explain the reported severity on its own. The most likely
remaining multipliers, in order of suspicion:
   - **Concurrent load** — the original report describes real team usage,
     not a single isolated batch; Phase 1.6 (3 concurrent
     tenants/sessions) directly tests whether shared vision/render slots
     under real concurrent usage multiply this further. Not yet run as
     of this writing.
   - **Real Cloudinary latency may exceed the assumed 12s centre** —
     finding 3 above (supersampled canvas size) is a concrete,
     evidence-based reason real latency could run higher than a generic
     estimate; this reproduction's mock cannot measure it directly.
   - **Real customer photos** are likely heavier than this reproduction's
     synthetic 1200-1600px gradients (higher resolution, more complex
     segmentation masks) — blocked on `LOCAL_ISSUE_DIR` for a genuine
     before/after comparison (Phase 2/3's blocker applies here too).

### Phase 1.4 — what was actually fixed, and an honest look at what it did and didn't move

Two of the six fix candidates the original spec listed were already
implemented before this program started — confirmed by reading the code,
not assumed: **"skip the provider when no padding is needed"**
(`src/jobs/worker.ts:176-178`'s `hasOverflow(overflow)` check — the
`ai_extend` path is never entered at all when there's no overflow to
fill) and **"never re-upload cached work"**
(`src/jobs/worker.ts:186-199`'s pre-render cache check against the
derived-asset store, keyed by `(sourceHash, kind)`, plus
`handleBackgroundFillJob`'s own cache check before calling Cloudinary).
Neither needed a change; both are noted here so the final report doesn't
list them as open gaps.

**Implemented**: event-driven wake-up for a completed background fill,
replacing part of the fixed-5s-poll cost. `src/jobs/queue.ts`'s new
`wakeRenderJobsWaitingOn(tenantId, sourceHash, templateId)` is called
from `src/jobs/pool.ts`'s `job:done` handler the instant a
`background_fill` job completes — it immediately clears `available_at`
on any `render` job deferred waiting on exactly that (photo, template)
pair, so the render becomes claimable on the render worker's very next
idle-poll iteration (capped at `MAX_IDLE_INTERVAL_MS` = 2s,
`worker-entry.ts`) instead of waiting out the remaining portion of a
fixed 5s window. Scoped strictly: matched by tenant AND exact
(sourceHash, templateId), filters by `kind = 'render'` only (a
`background_fill` job waiting on AI-Extend *capacity*, not on another
fill, is correctly left untouched). Covered by 4 new tests in
`tests/jobs/queue.test.ts` (wakes a matching deferred render; leaves a
different sourceHash/templateId alone; never touches a `background_fill`
job; never crosses tenants).

**Measured, honestly — two different scenarios, two different outcomes:**

| Scenario | Before | After | 
|---|---|---|
| 30-image bulk batch, Phase C (`docs/evidence/issue4-repro-30img-12s{,-after-wakeup-fix}.log`) | 230.9s, 7.8 img/min | 244.3s, 7.4 img/min |
| Single interactive image (`docs/evidence/issue4-repro-1img-12s-after-wakeup-fix.log`) | up to 5s poll tail (by construction of the old fixed-interval code) | render re-claimed ~475ms after its fill completed (fill done at relative ms=8423, render re-claimed at ms=8898) |

**The bulk-batch number did not improve — within run-to-run noise from
the mock's own latency jitter (±40%, 8% rate-limit rate), if not
slightly worse.** This is the correct, expected result once the
mechanism is understood, not a failed fix: for a 30-image batch, overall
wall-clock time is gated by `AI_EXTEND_PER_TENANT_CONCURRENCY=2`
processing 30 fills in sequence (finding 5's `ceil(30/2) × 12s = 180s`
floor) — by the time any one render's fill finishes, dozens of other
renders are still waiting on fills that haven't even started yet, so
shaving a few seconds off one render's own poll tail doesn't move the
batch's completion time, which is set by the LAST fill to finish. The
fix's real, confirmed value is the **single-image interactive case** —
exactly the one path where there is no "other work to hide behind": a
user generating one `ai_extend` creative now notices completion in
roughly the fill's own latency plus one render-worker poll cycle
(≤2s) rather than plus up to a full `BACKGROUND_FILL_POLL_MS` (5s).

**Deliberately not done in this phase** (concurrency defaults, the
supersampled-canvas-size issue, provider-capacity raises): each needs
either Phase 1.6's concurrent-load numbers or a render-team decision on
a visual-quality tradeoff before being touched, per finding 3's own
caveat — raising `AI_EXTEND_PER_TENANT_CONCURRENCY`/
`CLOUDINARY_JOB_CONCURRENCY` or `JOB_RENDER_CONCURRENCY` blindly, without
that data, is exactly what this program's "no default changes without
evidence" rule exists to prevent. No config default was changed in this
phase.

---

## Issue 5 — Floating model with head-space padding

**Status: Confirmed** — no grounding/contact-shadow logic exists anywhere
in the pipeline.

There is no "headspace" concept by that name in the code; it corresponds to
`constraints.overflow: 'allow'` generating AI-Extend padding above/below
the subject. The boundary classifier (`src/render/boundary-classify.ts`)
only distinguishes `garment`/`skin`/`background` per edge — there is no
anchor-aware logic that treats the `feet` anchor specially, and the actual
fill prompt sent to Cloudinary (`src/services/cloudinary-service.ts:104–105`)
is one generic "continue this photograph's existing backdrop floor
lighting and shadow" instruction, identical regardless of which edge
(above the head vs. below the feet) is being filled. Floor continuation
and foot-contact shadow are left entirely to the generative model's own
guess, with nothing in the pipeline telling it where the ground plane or
the subject's feet actually are.

**Files**: `src/render/boundary-classify.ts` (edge classification),
`src/services/cloudinary-service.ts:104–105` (`buildFillPrompt`'s floor
clause).

**Fix plan**: when the bottom edge needs padding and a `feet`/`ankle_center`
anchor is available, (1) tell Cloudinary explicitly where the feet are and
ask for a grounded contact shadow there (an edge-specific prompt addition,
same mechanism already used for the garment-continuation case), and/or (2)
for plain/solid backgrounds, composite a simple synthetic contact shadow
locally from the feet anchor and leg/shoe mask — gated behind a
`groundShadow: off | auto` template setting, default `off` for existing
templates (no silent behavior change) and `auto` for newly created ones, as
the spec requests.

**Acceptance test**: a fixture with top+bottom head space set must show the
subject's feet meeting a visually grounded floor/shadow, not floating in
empty padding.

---

## Issue 6 — Cannot handle multiple concurrent logins/requests

**Status: Needs live-settings-aware re-verification, not a rebuild.**

This is exactly what the multi-tenancy work (completed in the
`multi-tenancy` branch, merged into this branch's history) was built to
solve — per-tenant fair-share scheduling, per-tenant quotas, and a job
queue that doesn't serialize across tenants. The P6 load test already
confirmed this holds under **synthetic** (fast-mode) load. What's missing
is confirmation under the *specific* scenario the issue describes — 3
concurrent logins/sessions issuing real work at once, on **this exact
production box's live settings** (vision/render concurrency = 1 each),
where a single global concurrency=1 could still make 3 users *feel*
serialized even though the scheduler itself is fair — because there's
only one vision slot and one render slot to share between them, fairly or
not.

**Fix plan**: re-run the equivalent of the P6 load test's scenario 2 (one
heavy + several light tenants) in **real mode** (real ONNX, mocked AI
Extend) at this box's actual settings, plus the specific "3 logins, same
account, concurrent uploads+generates+downloads" scenario the spec's
1.6/Scenario B describes. If queue wait and web p95 per user are
reasonable, this issue is actually "feels slow because concurrency=1
everywhere," which issue 4's fix addresses — not a scheduler fairness bug
needing new code.

**Acceptance test**: Scenario A (3 tenants) and Scenario B (3 sessions, 1
tenant) both report queue wait and web p95 per user; no request blocks
indefinitely.

---

## Issue 7 — Hanger/flat-lay shots: tilted hanger or line above it

**Status: Confirmed root cause does NOT match the original hypothesis; a
different, also-confirmed cause found.**

No deskew/rotation logic is being inappropriately applied. `computeRoll`
exists (`src/vision/providers/onnx/face.ts:203–220`) and
`FramingSpec.levelEyeLine` is a declared field (`src/framing/types.ts:176`,
defaulted `false` everywhere) — but it is **never read** anywhere in
`solver.ts` or `compositor.ts` (confirmed by repo-wide search). It's dead,
unimplemented code, not active logic that could be misfiring on a
no-person shot. The only real rotation in the pipeline is EXIF-orientation
normalization, applied uniformly regardless of shot type — correct,
standard behavior, not a bug.

Two real, confirmed issues instead:

1. **AI Extend is never gated by shot type.** `handleRenderJob` only checks
   `background.mode === 'ai_extend'` and whether the crop overflows — not
   whether the shot has a person at all. A hanger/flat-lay shot assigned to
   an on-model template with `overflow: 'allow'` gets AI Extend padding
   exactly like a person shot would, instead of falling to a dedicated
   `flat_lay` preset (`overflow: 'shrink'`, no padding) that wouldn't
   generate anything.
2. **No boundary vocabulary exists for a hanger/hook.** The edge classifier
   only knows `garment`/`skin`/`background` — a hanger or hook is neither,
   so it's classified `background` and gets the generic "continue
   backdrop" prompt with zero instruction to preserve it. Combined with
   `compositor.ts`'s own documented, still-unresolved seam at the join
   between the real photo and Cloudinary's generated pad (explicitly
   called out in that file's comments as an inherent, previously-attempted-
   and-never-fully-eliminated artifact), a visible line right above a
   hanger is consistent with this known compositing seam landing exactly
   at the crop's top edge — not a new bug, and not a deskew problem.

**Files**: `src/jobs/worker.ts` (`handleRenderJob`/`handleBackgroundFillJob`
— no shot-type gate), `src/render/boundary-classify.ts` (no hanger/hook
category), `src/render/compositor.ts:218–234` (documented seam).

**Fix plan**: (1) skip AI Extend entirely for `product_only`/`flat_lay`
shot types regardless of the assigned template's own background mode — a
genuinely correct answer to "no-model shots shouldn't request generative
backdrop extension" rather than relying on every template being
hand-configured correctly, (2) for these shot types, use subject-box
framing with no overflow/padding by default, which sidesteps the unresolved
seam entirely by never inviting it, rather than trying to eliminate a seam
multiple past attempts already couldn't fully remove.

**Acceptance test**: a hanger/flat-lay fixture, run against an on-model
template with AI Extend enabled, must not trigger a generative fill and
must show no tilt and no visible line at the crop edge.

---

## Issue 8 — Direct image upload option

**Status: Confirmed feature gap, not a bug.**

Only one import input method exists today: a folder picker
(`<input type="file" multiple webkitdirectory>` in
`src/components/import/import-client.tsx:297–307`), streamed via Busboy to
`src/app/api/imports/[importId]/files/route.ts`. **No zip upload and no
URL/link import exist anywhere in the codebase** (confirmed by targeted
search — zip only ever appears as an export format, never as an import
input). There is therefore no SSRF surface to evaluate, since the feature
that would need SSRF protection doesn't exist.

The backend is already input-agnostic: the files route takes arbitrary
`files`/`paths` multipart parts with no dependency on folder structure
(`normalizePath` already falls back to the bare filename), and
`import-service.ts`'s product-grouping already degrades gracefully to "one
product per image" with no shared folder path. The client's own
`handlePick` already computes `relativePath` with a `file.name` fallback.

**Fix plan** (UI-only — no backend route or validation changes needed): add
a plain `<input type="file" multiple>` (no `webkitdirectory`) and/or a
drop-zone, wired to the same `handlePick`/batching/`startImport` flow
already in `import-client.tsx`, reusing `/api/imports` +
`/api/imports/[importId]/files` unchanged.

**Acceptance test**: selecting or dropping individual image files (not a
folder) imports them successfully, each becoming its own product by
default, through the existing quota/dedup/limit checks with no new code
path.

---

## Issue 9 — WebP download problem (502 Bad Gateway)

**Status: Strong hypothesis**, grounded in both the screenshot evidence
(actual 502 from nginx, confirming this is an upstream-timeout/crash
symptom, not a clean app error) and the export code's own structure.

`encodeWithinSizeBudget` (`src/render/export-image.ts:91–121`) runs a
binary search of **up to ~7 sequential full-resolution encodes** of the
same image when a caller requests a size-budgeted export
(`sizeMinKb`/`sizeMaxKb`). WebP encoding is markedly more CPU-expensive
than JPEG at comparable settings on large studio photos. Error handling
itself is sound — every route is wrapped in `handler()`, which maps any
thrown error to a clean 500, and no missing-await was found on this path —
so the 502 is not a crash/unhandled-exception bug but a **timeout**: seven
sequential expensive WebP encodes, especially layered under the bulk ZIP
route's own internal concurrency (`zipInternalConcurrency`, default 3),
can plausibly run long enough to exceed nginx's `proxy_read_timeout` or
Next's `maxDuration`, during which the process is alive and busy — not
crashed — producing exactly a 502 with no app-level error ever generated.

**Files**: `src/render/export-image.ts:91–121` (`encodeWithinSizeBudget`),
`src/app/api/creatives/download/route.ts` (bulk ZIP, internal concurrency),
`src/render/export-concurrency.ts` (global/tenant slot caps).

**Fix plan**: cap the binary search's cost specifically for WebP (fewer
iterations, or skip the size-budget search for WebP and use a direct
quality-to-size heuristic instead), and/or raise nginx's
`proxy_read_timeout` for export routes specifically as a backstop — but the
real fix is bounding the worst-case encode cost, not just hiding a slow
request behind a longer timeout.

**Acceptance test**: a size-budgeted WebP export of a large studio photo
completes within a bounded time (measured, not assumed) under concurrent
load matching the bulk-ZIP scenario, with no 502.

---

## Issue 10 — Tool hangs and gets stuck

**Status: Needs Phase 1 diagnostics; one real contributing bug found, not
yet the full explanation.**

Current queue state on production is quiescent (no pending/stuck jobs right
now), and there's no OOM evidence — so whatever "stuck" looks like to the
team is either intermittent, already resolved by the time I checked, or
presents as something other than a literally-wedged queue (e.g., issue 4's
slowness simply *feels* like hanging).

One real, concrete bug found while gathering evidence: **deleting a
product never cancels its still-queued vision jobs.**
`src/services/cleanup-service.ts`'s `deleteProduct` removes the product's
image rows and files but has no call to cancel associated queue jobs
(`queue.deleteJobsForBatch` exists and is used elsewhere, but not here). If
a vision job is still pending/claimed when its product gets deleted, the
job fails permanently once claimed, with an `ENOENT` reading a file that no
longer exists — confirmed directly: 25 of the last ~5,940 production jobs,
all for one tenant, all `ENOENT` against images that no longer exist in
that tenant's current database. Not itself a hang, but real failure-log
noise that could easily look like "something's stuck" to anyone watching
job status without realizing the underlying image was deleted out from
under it.

Separately, there IS a per-job watchdog (`src/jobs/pool.ts:261`,
`checkWatchdog`) that kills a job exceeding its kind's max runtime — but
there is **no pool-level stall detection**: nothing currently notices "jobs
pending, workers idle, no progress for N seconds" as a distinct failure
mode from "one job is individually hung." This is exactly the gap Phase
1.5 asks to fill.

**Fix plan**: (1) cancel a product's own queued jobs in `deleteProduct`
before removing its rows, (2) build the Phase 1.5 stalled-pool
self-heal (restart the pool and log it when there's queued work, idle
workers, and no progress for N seconds) as new capability, not a fix to
existing broken logic, since nothing like it exists today to be broken.

**Acceptance test**: deleting a product with in-flight jobs produces no
orphaned failures; a stalled pool (simulated) self-heals within N seconds
and logs the event; the soak test (3 users × 100 images × 30 min) ends with
zero stuck jobs and counters back to zero.

### Phase 1.5 — orphaned-jobs-on-delete: fixed

Part (1) of the fix plan above is done. `src/jobs/queue.ts`'s new
`deleteJobsForImages(tenantId, imageIds)` permanently deletes every job
row (any kind, any status) whose payload names one of the given image
ids, called from both `deleteProduct` and `deleteImport`
(`src/services/cleanup-service.ts`) before the cascade removes the image
rows — `deleteImport` had the identical bug (it cascades through every
product in the import) and is fixed the same way. Image ids are matched
in application code rather than a new `json_extract` SQL query, same
reasoning as Phase 1.4's `wakeRenderJobsWaitingOn`.

There was no existing test file for `cleanup-service.ts` at all — this
is new coverage, not just a regression check: `tests/services/cleanup-
service.test.ts` (5 tests) covers a pending vision job being deleted
with its product, a claimed render job being deleted with its
`running_jobs` counter correctly decremented, a sibling product's jobs
being left untouched, `deleteImport` cancelling jobs across every image
under it, and tenant scoping (an adversarial same-imageId-different-
tenant case).

Part (2a) — stalled-pool self-heal — is now done too. `src/jobs/pool.ts`'s
new `isPoolStalled` (pure, unit-tested in `tests/jobs/pool-watchdog.test.ts`,
7 new tests) answers "is there pending work for a kind where every capable
worker is currently idle" — distinct from the existing per-job watchdog,
which only ever sees one job stuck inside a native call and has no way to
notice the pool as a whole silently failing to claim anything at all
(every worker correctly reports 'idle' whether the queue is genuinely
empty or `claim()` itself is broken — see the function's own doc comment).
`WorkerPool.checkStall()` runs on the existing 10s watchdog tick; once the
stalled condition holds continuously for `JOB_STALL_THRESHOLD_MS`
(default 30s, new config key), it logs a `STALL DETECTED` line and does a
full `stop()` + `start()` — the same restart path `scripts/loadtest-
multitenant.ts`'s chaos scenario already exercises — then counts the
restart in a new `stallRestartCount`, surfaced through `PoolStatus`,
`getDiagnostics()`, and `npm run diag`'s output so an operator can see
"this box has self-healed N times" without grepping logs. Deliberately
conservative: a busy or still-starting worker ANYWHERE in the pool
suppresses the whole check, even for an unrelated kind — restarting the
entire pool is disruptive enough (every in-flight job rides out the
normal graceful-shutdown grace period or gets returned to pending) that
it should only fire on "nothing in the whole pool is happening", not a
narrower per-kind imbalance, which is Phase 1.6's territory, not this
one's.

Part (2b) — worker recycling after N jobs/an RSS threshold, startup
memory budget, the UI "stalled, no progress for N min" state with
Retry/Cancel, slow-request logging, and streaming upload/ZIP
verification — plus Phase 1.6's concurrent-login verification and
Phase 1.7's soak test — are not yet done.

---

## Phase 4 feature scope note

**Correction to the original framing of this feature**: per-strategy
shot-type filtering is not new — it already exists and is already used by
every built-in preset (`strategy.shotTypes`, enforced in
`src/framing/solver.ts:206`). Phase 4 is therefore an editor UI over an
existing solver mechanism, not new solver logic — a view that lets someone
edit which strategy chain applies to which shot type, through the same
`shotTypes` field the solver already reads. No existing template requires
migration under the design the spec describes, since nothing about the
underlying resolution order changes. Deferred to its own phase as
instructed; not investigated further in Phase 0 beyond confirming this.

---

## Open items before Phase 1 can fully proceed

1. **`LOCAL_ISSUE_DIR`** — needed for real fixture-based reproduction and
   before/after evidence on issues 1, 2, 3, 7 specifically (pixel-level
   comparisons). The pasted chat images are supporting qualitative
   evidence only, not suitable as deterministic test fixtures.
2. **Actual template IDs** behind the black-bar examples (issue 3) — to
   directly inspect their `background.color` values rather than reasoning
   about it in the abstract.
3. ~~Confirmation of whether `selectStrategy` consults shot type~~ —
   resolved: it does, via `strategy.shotTypes` (see Issue 1 above). The
   remaining precise fix for issue 1 is anchor-level trustworthiness
   (a `cropped`/`untrustworthy` flag on `head_top` when `headVisible` is
   false), which is independent of shot-type filtering and still needs to
   be built — not blocked on fixtures, a Phase 2 code task.
