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

**Status: Fixed** (code and tests; this status line was stale until
2026-10-21 — the fix below was committed but the write-up never got
updated to match. Caught only when directly asked whether this issue was
resolved and re-checked against git history rather than trusted as-is).

Root cause had two layers. **Classification** was already correct:
`src/vision/analysis/shot-type.ts`'s `headVisible` requires a real face
detection or a pose keypoint clearing `HEAD_KEYPOINT_FLOOR = 0.7`, and
explicitly excludes out-of-frame/extrapolated keypoints via `inFrame()`.
The real gap was one layer down, in the **framing solver**:
`src/vision/analysis/anchors.ts`'s `estimateHead` still produces a
`head_top` anchor whenever a person is detected at all (its person-box-
proportions fallback), independent of whether `headVisible` said the
head is actually trustworthy — and `src/framing/solver.ts`'s `hasAnchor`/
`enforceKeepInside` only ever checked confidence, so a cropped-but-
confidently-detected partial face (a real, if incomplete,
`face_landmarks` hit) could carry high confidence despite being
extrapolated above the frame (`head_top.y < 0`).

**Fix** (commit `918b88e`): new `isAnchorTrustworthy()` in
`src/framing/solver.ts` rejects a head-derived anchor (`head_top`,
`eye_line`, `chin`) extrapolated above the frame, regardless of
confidence. Used by both `hasAnchor` (a strategy requiring that anchor is
now correctly skipped, same as if it were missing) and
`enforceKeepInside` (the solver no longer zooms out trying to pull an
above-frame head into view — the exact mechanism that was turning a
half-face crop into a full-face one). Covered by
`tests/framing/solver.test.ts`'s "a cropped head never gets forced into
frame (issues 1/11)" suite: confirms the above-frame case correctly falls
through to the anchor-free fallback, and confirms a same-position
in-frame anchor is NOT over-rejected.

**Not yet confirmed against a real photo end-to-end** (no `LOCAL_ISSUE_DIR`
fixture was ever provided for this issue specifically) — the fix is
verified against the exact mechanism the bug report described, via
synthetic anchors reproducing the documented failure (a `head_top`
extrapolated to negative y), not via re-rendering the original reported
photo.

---

## Issue 2 — Full-length pants become short pants

**Status: Fixed.** The originally-hypothesized mechanism (an
`ANCHOR_FLOOR` vs. strategy `minConfidence` gap on the `feet` anchor
itself) was **empirically tested and disproved** before implementing
anything — `enforceKeepInside` was already pulling a low-confidence
`feet` anchor back into frame regardless of whether `head_to_feet`
itself could use it (confirmed with a synthetic `solveFraming()` call: a
`feet` anchor at confidence 0.15, well under every relevant threshold,
still got the crop extended to include it). The original "Confirmed root
cause" status was a hypothesis that read correctly from the code's
structure but turned out wrong once actually run — recorded here rather
than quietly dropped.

**The real, confirmed gap**: `ankle_center` and `feet` are two
**separate** anchors (`src/vision/analysis/anchors.ts`) — `feet` depends
on garment-parse pixels or the person mask reaching the floor, which can
fail (a dark hem against a dark floor, a shadow, a mask that doesn't
extend past the frame) even when the pose model's `ankle_center`
keypoint is confidently resolved. `shot-type.ts`'s `anklesVisible`
signal already trusts `ankle_center` alone to classify a shot
`full_body` — but the solver's `keepInside` list
(`full_body_editorial`'s `constraints.keepInside`, `types.ts:282`) never
named `ankle_center`, only `feet`. So whenever `feet` was weak or
entirely absent, a confidently-detected ankle got silently cropped out
by `head_to_knees`'s knee-level fallback — full pants read as shorts —
even though the pose model had already told the classifier the ankles
were there.

**Fix**: `ankle_center` added to `full_body_editorial`'s `keepInside`
list, alongside `feet`. Confirmed with a synthetic test (no fixture
needed — this is pure solver logic): a `full_body` subject with a
confident `ankle_center` and no `feet` anchor at all now gets a crop
whose bottom edge reaches the ankle, not the knee.

**Files**: `src/framing/types.ts:282` (`full_body_editorial`'s
`keepInside`), `src/framing/solver.ts` (`enforceKeepInside`, unchanged —
the existing mechanism already worked correctly once given the right
anchor name).

**Tests**: `tests/framing/solver.test.ts` — one test reproducing the
ORIGINAL hypothesis to document why it doesn't hold (feet already
protected), one reproducing the REAL gap and confirming the fix (ankle
no longer cropped out when feet is absent).

---

## Issue 3 — Black bars top/bottom

**Status: Fixed.** The original two hypotheses stayed ruled out
(uninitialized transparent canvas; a failed AI Extend silently falling
back) — the third, "an invalid/empty `background.color`", was confirmed
**empirically**, not just by reading the code: `@napi-rs/canvas` (the
actual rendering engine, tested directly) keeps the previous `fillStyle`
on an invalid assignment, defaulting to black on a fresh context. The
real path an invalid value reaches a template: the free-text hex field
next to the colour swatch (`src/components/builder/background-
controls.tsx`) has no `onChange` validation, and the swatch's own
display fallback to white can make an already-broken saved value look
fine in the picker while the underlying `background.color` stays
invalid.

**Fix** (all three parts of the original plan, done):
1. `src/templates/types.ts`'s new `isValidHexColor`/
   `sanitizeBackgroundColor` — one shared source of truth.
2. `src/app/api/templates/[templateId]/route.ts`'s `validateDocument`
   now rejects a non-hex `background.color`/`gradientFrom`/`gradientTo`
   at save time.
3. `src/render/compositor.ts`'s `drawBackground` sanitizes the color
   before every use regardless — a backstop for whatever is already in
   the database today, which (2) alone can never fix retroactively.

Also built the invariant I3 backstop: `detectAnomalousBlackEdges`
(exported, pure pixel logic) runs after every render, comparing the
edge bands' near-black ratio against the image's own centre — flagging
the "black bars" symptom from ANY future cause while correctly letting
a genuinely all-black product photo through (its centre is near-black
too, so the comparison doesn't fire). A flagged render throws
`RenderQualityError` rather than shipping silently.

**Files**: `src/templates/types.ts`, `src/app/api/templates/
[templateId]/route.ts`, `src/render/compositor.ts`.

**Tests**: `tests/templates/background-color.test.ts` (8 tests, the
validator/sanitizer — pure, no fixture) and `tests/render/black-edge-
detection.test.ts` (5 tests, the backstop — paints known patterns
directly with `@napi-rs/canvas`, the real engine, still no photo
needed). The actual corrupted template(s) in production were never
directly inspected (no template IDs were provided) — not needed once
the mechanism was confirmed and fixed at every layer it could occur.

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

**Status: Fixed (fix plan item 1 only) — with an honest limit on what
could actually be verified.** New `needsGroundedFeet`
(`src/render/compositor.ts`, exported, pure) is true exactly when the
bottom edge is being padded AND the photo has a real `feet` or
`ankle_center` anchor. `buildFillPrompt`
(`src/services/cloudinary-service.ts`) takes a new `groundFeet`
parameter and, when true, appends an explicit instruction: continue the
floor surface at the same perspective beneath the subject's actual feet
and place a contact shadow there — the same "append an edge-specific
clause to the base prompt" mechanism already used for garment
continuation, not a new code path. Wired through both
`computeAiExtendPlan` and `buildAiExtendTarget` (the two functions
`handleRenderJob`'s cache lookup and `handleBackgroundFillJob`'s actual
generation call already share for the garment-edge case), so both call
sites compute the identical flag and can never disagree — the same
guarantee `aiExtendCacheKind` already relied on for `edgeContent`.

**What this fix cannot verify, and why**: this is a prompt change aimed
at a GENERATIVE model's output. There is no way to check whether
Cloudinary's actual generated image shows better grounding without
either a real API call (spending a real credit — explicitly against this
program's own rules) or a human looking at real output. 14 new tests
(`tests/render/ground-feet.test.ts`, `tests/services/cloudinary-fill-
prompt.test.ts`) verify everything that IS mechanically checkable
without that: the trigger condition is correct (bottom-only, anchor
required), the composed prompt text actually contains the grounding
instruction when expected and doesn't when not, it combines correctly
with the garment clause, and a different `groundFeet` value produces a
different prompt string (which is what makes `aiExtendCacheKind`
correctly treat it as a different fill to generate, not a cache hit on
the old ungrounded one). Whether the instruction actually *works* on
real photos is unverified — flagged here rather than assumed.

Fix plan item 2 (a locally-composited synthetic contact shadow, gated
behind a new `groundShadow` template setting) was NOT attempted: it's a
new rendering feature requiring a schema change and visual tuning that
can only be judged by looking at real output, which carries the same
verification problem as the prompt change but with more surface area
(new template field, new compositing code) for something still unverified
to go wrong. Left for a future phase if the prompt-only fix proves
insufficient once real photos are available.

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

### Phase 1.6 — verification results (real data)

`scripts/verify-issue6-concurrency.ts` ran both scenarios against a real
server (real ONNX vision, real render, Cloudinary mocked at 4s) at the
confirmed live settings, 10 images per user/session — full log in
`docs/evidence/issue6-concurrency-verification.log`:

| Scenario | Per-user queue wait | Poll p95 (web latency) |
|---|---|---|
| A — 3 different tenants | 48.4s / 49.2s / 48.4s (spread: **0.8s**) | 14-23ms, all users |
| B — 3 sessions, same account | 32.1s / 105.1s / 66.7s (spread: **72.9s**) | 21-22ms, all sessions |

**Scenario A: confirmed fair, no cross-tenant blocking.** Three
different tenants running the identical workload concurrently finished
within 0.8s of each other — the multi-tenancy scheduler's per-tenant
fairness holds under real load at live settings, not just the P6 load
test's synthetic fast-mode. Web p95 stayed under 25ms for every tenant
throughout — no evidence any tenant's requests were starved by another's
work.

**Scenario B: a real, measurable disparity — but not a scheduler bug.**
One session (105s) took 3.3x longer than another (32s) despite
identical workloads submitted at the same time. Root cause, read
directly from the per-stage logs this run produced: all three sessions
belong to the SAME tenant, so all 30 images (3 sessions x 10) compete
for that ONE tenant's shared `AI_EXTEND_PER_TENANT_CONCURRENCY=2` fill
slots and its share of the global render concurrency — there is no
separate "fairness between batches of the same tenant" layer, only
fairness BETWEEN tenants. Jobs are served in roughly enqueue order
within one tenant's own backlog, so whichever session's images interleave
less favorably in the claim order simply waits longer — the AGGREGATE
work (30 images against 2 fill slots) takes however long it takes
regardless of which session's progress bar that time shows up in.

This is architecturally expected given the current design (one tenant,
one shared capacity pool), not a defect to patch — a real fix would mean
designing round-robin fairness BETWEEN a tenant's own concurrent batches,
a meaningfully larger change than anything else in this phase, and not
something to build speculatively without a concrete product decision
that it's worth the complexity. What it DOES confirm: the user-facing
complaint "can't handle 3+ concurrent logins" is real and reproducible —
just caused by shared per-tenant capacity, not a queue/scheduler bug —
and Phase 1.5's work already directly mitigates the SYMPTOM even though
it doesn't eliminate the underlying wait: the stalled-batch UI (Phase
1.5) shows session-2's slower batch making honest progress rather than
looking stuck, and the event-driven wake-up (Phase 1.4) removes any
EXTRA poll-tail delay on top of the real wait.

**Recommendation**: no code change in this phase. If intra-tenant batch
fairness becomes a real product priority, it needs its own scoped design
(e.g., round-robin job ordering across a tenant's own concurrent
batches) — flagged here for a future phase, not attempted speculatively.

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

**Status: Fixed** (fix plan item 1; item 2 turned out unnecessary — see
below). New `eligibleForAiExtend`/`AI_EXTEND_INELIGIBLE_SHOTS`
(`src/vision/analysis/shot-type.ts`) name exactly `product_only` and
`flat_lay` — deliberately narrower than "no person detected": `detail`
(a fabric/hardware/texture close-up) is excluded on purpose, since
extending the backdrop around an extreme close-up can be exactly what's
wanted, and issue 7's own evidence is specifically about hanger/flat-lay
shots.

New `resolveEffectiveBackground` (`src/jobs/worker.ts`, pure, exported
for direct testing) downgrades a template's `ai_extend` mode to
`edge_extend` — stretch the existing pixels, no network call, no
compositing seam — whenever the photo's shot type is in that ineligible
set, regardless of what the template itself is configured to use.
Wired into **both** `handleRenderJob` (so the actual render never
requests a generative fill for these shots) and `handleBackgroundFillJob`
(so a fill job queued before this fix, or raced from a different code
path, doesn't spend a real Cloudinary credit on a fill the render will
now never look for).

Fix plan item (2), "use subject-box framing with no overflow/padding",
turned out to be unnecessary once item (1) was actually implemented:
`boundary-classify.ts`'s missing hanger/hook vocabulary and
`compositor.ts`'s documented photo/generated-pad seam are both only
reachable through the `ai_extend` code path — now that these shot types
never enter it at all, both are moot for them, not just mitigated. No
solver/framing change was needed, which also means no risk to templates
using `product_only`/`flat_lay` shot types for anything else.

**Tests**: `tests/vision/shot-type-ai-extend.test.ts` (4 tests) and
`tests/jobs/worker-ai-extend-gate.test.ts` (7 tests) — both pure
decision logic, no fixture needed.

**Partially reverted (2026-10-21), with real evidence this time.** The
`product_only` half of this gate turned out to cause a worse problem than
it prevented, found via the user's own real render batch (17 hanger
product photos, template `tpl_KEbdeKswkVEELlSb`): the vision engine
misclassifies some of these as `half_body` (a shirt's collar/shoulders on
a hanger scored a "person" at 0.79 keypoint confidence — a genuine false
positive, not fixed here) and correctly classifies others `product_only`.
The `half_body` ones got real AI Extend and came out clean — correct
background, a hanger drawn in. The `product_only` ones, forced onto the
edge-stretch by this gate, came out as a duplicated/ghosted pixel-stretch
artifact — visibly worse than the tilted-hanger/seam problem the gate
was built to prevent, on the exact kind of photo (hanger product shot)
this issue is about.

`AI_EXTEND_INELIGIBLE_SHOTS` now excludes only `flat_lay`; `product_only`
is eligible for AI Extend again. The original decision was reasoned
correctly from the code's structure but never confirmed against a real
render batch — this is the same pattern as issue 2's disproven
hypothesis: a well-reasoned fix that didn't survive contact with real
data. Left `flat_lay` excluded since no real evidence exists either way
for that shot type specifically; revisit if/when it does.

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

**Status: Fixed (fix plan item 1).** `encodeWithinSizeBudget`'s binary
search is now capped at `config.render.webpSizeBudgetMaxIterations`
(default 4, new `WEBP_SIZE_BUDGET_MAX_ITERATIONS` env var) for WebP
specifically — JPEG keeps its natural ~7-iteration convergence
unchanged, since JPEG's own per-encode cost was never the reported
problem. A narrower search still lands within roughly 100/2^4 ≈ 6
quality levels of the ideal, a bounded, deliberate precision tradeoff
against the previously-unbounded wall-clock cost. This halves the
worst-case number of full-resolution WebP encodes per export (from 8
down to 5: the quality=1 floor plus up to 4 search iterations instead
of up to 7), which directly bounds the contributor to a 502 that this
issue's own evidence and code-structure analysis identified.

**Tests**: `tests/render/webp-size-budget.test.ts` (4 tests) spy on
real `sharp.prototype.webp`/`jpeg` calls — not just the loop's own
internal logic — to verify the actual number of encodes stays within
the cap under a budget tight enough to force a full search, that JPEG's
own cap is unaffected, and that a capped (not fully converged) search
still returns a valid, correctly-formatted image.

**Not done**: raising nginx's `proxy_read_timeout` for export routes
(fix plan item 2) — an operational/infrastructure change outside this
codebase, left as an operator-side backstop recommendation rather than
something to implement here. The real fix (bounding worst-case encode
cost) is the one that matters; a longer timeout alone would only hide a
slow request for longer, not fix it.

---

## Issue 10 — Tool hangs and gets stuck

**Status: Fixed** (this header was stale — written before the fix plan
below was completed; both parts are done and validated by the Phase 1.7
soak test further down, which ran 300 images across 3 tenants with zero
stuck jobs). One caveat carried forward honestly: the UI stall warning
itself (3-minute no-progress alert) was never exercised against a real
live 3-minute stall, only verified via types/lint/build — see "Honestly
scoped" below.

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

Part (2b) — worker recycling and the startup memory budget — done.
`src/jobs/pool.ts`'s new `shouldRecycleWorker` (pure, unit-tested —
6 new tests) recycles a worker after `JOB_WORKER_MAX_JOBS` jobs (default
500) or once its RSS crosses `JOB_WORKER_MAX_RSS_MB` (default 1536MB,
well over double a healthy ~700MB vision worker) — bounding exposure to
a slow native-library leak (ONNX/sharp/skia state is resident for the
whole process life) without needing to diagnose the leak itself. Runs
after every `job:done`; the actual recycle reuses the same graceful-
stop-then-force-kill-and-return-the-job path `stop()` already used for a
full pool shutdown, now extracted into a shared `gracefulStopHandle`,
and always respawns at `restarts=0` (a clean, intentional exit, not a
crash, so it never counts against `MAX_RESTARTS`). `/proc` RSS reads
were already written once for `npm run diag` (Phase 1.2) — extracted to
`src/lib/process-rss.ts` and shared rather than duplicated.

`checkMemoryBudget` (pure, 3 new tests) runs once at pool startup: logs
a warning — never refuses to start, concurrency env vars are an
explicit operator choice — when the configured vision/render/
background_fill slot counts' ESTIMATED resident memory exceeds 80%
(`JOB_STARTUP_MEMORY_BUDGET_FRACTION`) of the machine's total RAM, using
the same rough per-kind estimates (~700MB vision, ~150MB render, ~80MB
background_fill) as the recycling RSS ceiling.

Slow-request logging — done. `src/lib/api-handler.ts`'s new
`callAndLogIfSlow` times the actual route handler call (not request
parsing or auth resolution) in both `handler()` and `adminHandler()` —
every API route funnels through one of the two, so this is one change
site, not per-route instrumentation. A call exceeding
`API_SLOW_REQUEST_MS` (default 2000ms, new `observability` config key)
logs a `[slow-request] method=... path=... status=... ms=... tenantId=...`
line, matching the existing `[stage]`/`[pool]` bracket-tag convention —
and still logs (with `status=error`) when the handler throws, rather
than only covering the success path. 5 new tests in
`tests/lib/api-handler.test.ts` (there was no test file for this module
before) cover the threshold boundary, the thrown-error path, and that
`tenantId` is omitted for public/unauthenticated routes rather than
printed as `undefined`.

The UI "stalled, no progress for N min" state with Retry/Cancel —
done, on the main batch detail page (`src/components/generate/batch-
detail-client.tsx`), the primary place a user watches a run's progress.
New `src/hooks/use-progress-stall.ts` tracks how long a batch's
`completedJobs + failedJobs + cancelledJobs` count has gone unchanged —
deliberately NOT the batch's own `updatedAt`, which `batches.refresh()`
stamps on every poll regardless of whether anything actually progressed,
so it can't distinguish a stalled batch from one simply being polled.
After 3 minutes with no change (well above the backend's own 30s pool
self-heal window — a user should never see evidence of routine internal
recovery), a warning `Alert` appears with a "Cancel this run" button,
reusing the existing `PATCH /api/batches/[batchId]` cancel/retry actions
already wired into this page (confirmed no new backend endpoint was
needed).

Honestly scoped: this repo has no frontend test infrastructure at all
(`vitest.config.ts` is Node-only, zero `.test.tsx` files anywhere) — adding
jsdom/React Testing Library for one hook was judged out of scope for this
program. Verified via `tsc --noEmit`, lint (including the `react-hooks/
purity` and `react-hooks/set-state-in-effect` rules, which caught a real
`Date.now()`-in-a-ref-initializer issue and a synchronous-setState-in-
effect issue on the first pass), and a full `next build` (confirms the
'use client' boundary and bundling, not just types). **Not** verified
with an actual live-browser run of a genuinely stalled batch — reproducing
a real 3-minute stall needs either a very slow real job or patching the
threshold down temporarily, neither done here. Only applied to the main
batch detail page, not `bulk-generate-panel.tsx`/`product-generate-
panel.tsx`'s smaller inline progress widgets (no cancel/retry affordance
exists there at all currently) — left for a follow-up if wanted.

Streaming upload/ZIP verification — checked, already correct, no change
needed. Both paths were already fixed in earlier phases, confirmed by
reading the current implementation rather than assumed from their own
doc comments:
  - **Upload** (`src/app/api/imports/[importId]/files/route.ts`): a prior
    P0 fix already replaced a fully-buffered `request.formData()` with
    busboy streaming each file part directly to a temp file on disk
    while hashing incrementally — bytes are read off the wire once, never
    held in full in memory, with both the per-file (`MAX_FILE_BYTES`,
    enforced by busboy's own `limits.fileSize`) and per-request
    (`MAX_REQUEST_BYTES` = 48MB, checked chunk-by-chunk, aborting the
    stream early) caps enforced DURING the stream. 300 files in one
    request scales in metadata only (one small tracking object per file,
    no bytes retained) — memory stays flat regardless of file count.
  - **ZIP** — there is no ZIP *upload*/import feature in this codebase at
    all (confirmed: the only `archiver`/zip-library usage anywhere in
    `src/` is the creatives *download* route) — consistent with issue 8's
    own Phase 0 finding that direct zip import doesn't exist yet. The ZIP
    *download* path (`src/app/api/creatives/download/route.ts`) was
    already fixed in P4 (see its own extensive doc comment): `archiver`
    reads/converts each creative's bytes just before appending it to the
    archive, a few at a time (`config.render.zipInternalConcurrency`),
    with output already streaming to the client — peak memory is bounded
    by that concurrency, not by the archive's total size or creative
    count.

Phase 1.5 is now fully addressed.

---

## Phase 1.7 — soak test

**Status: PASS, all targets met.** `scripts/soak-test-phase17.ts` ran 3
tenants x 100 images (300 images total) concurrently, real ONNX vision +
real render + Cloudinary mocked at a realistic 12s, at the confirmed
live settings — full results in `docs/evidence/phase17-soak-test.log`.

| Target | Result |
|---|---|
| Drained within the outer timeout | **PASS** — 29.3 minutes total, matching the spec's own "30 minutes" framing for this workload size |
| No stuck jobs at the end | **PASS** — 0 jobs left in a non-terminal (pending/claimed/running) status across all 3 tenants |
| No corrupt completions | **PASS** — 0 completed jobs carrying a non-null error |
| Every tenant's `running_jobs` counter back to zero | **PASS** — all 3 tenants |
| Memory stayed flat (no unbounded growth) | **PASS** — 76MB -> 96MB, 25.4% growth over 117 samples across the full run, well under the 50% threshold and consistent with one-time setup cost (new tenant DB handles, fixture generation) rather than a leak — same caveat the original P6 load test's own memory-flat check already carried |

No stuck-job or leak behavior was found under a sustained 300-image,
3-tenant run at live settings. Combined with Phase 1.4's event-driven
wake-up (visible firing throughout this run's log — `[pool] woke N
render job(s)...`) and Phase 1.5's stall self-heal/worker recycling,
this is the strongest evidence yet that the queue/pool itself is not
the source of "the tool hangs and gets stuck" — the remaining open
question (per issue 4's own "4x gap" finding) is whether REAL production
conditions (heavier photos, true concurrent human usage, real — not
mocked — Cloudinary latency) differ enough from this synthetic soak to
still produce a hang in practice. That requires `LOCAL_ISSUE_DIR` and/or
real production monitoring over time, not something a synthetic soak
test running on this machine can settle on its own.

**Phase 1 is now complete.**

---

## Issue 11 — Mannequin image not resizing properly (reported after Phase 1)

**Status: Strong hypothesis, not yet fixture-confirmed** — reported via
the same tracker on 2026-10-19, after the original 10 issues. A
headless dress-form mannequin wearing a saree, shot outdoors under
dappled sunlight; no "after" image was captured, only the original —
consistent with a visibly wrong result rather than a crash.

**This is very likely NOT a new root cause** — it's issues 1 and 7's
already-documented gaps manifesting on a different kind of photo, which
raises their priority rather than adding new scope:

1. **Shot classification itself is not the problem.** `src/vision/
   analysis/shot-type.ts` already has a deliberate `flat_lay`/
   `product_only` fallback for "no person detected" (line ~155 literally
   names "a garment laid flat or on a ghost mannequin") and for "a body
   is in frame but no face or hair was detected" (~251-257). A mannequin
   correctly lands on one of these regardless of which way YOLOv8-pose's
   detection goes.

2. **The real gap: `enforceKeepInside` (`src/framing/solver.ts:381-456`)
   forces anchors into frame with no confidence floor.** Unlike
   `selectStrategy`'s own `hasAnchor` check (`solver.ts:248-251`),
   `enforceKeepInside`'s anchor filter (`solver.ts:393-399`) only checks
   `entry.anchor != null` — it reads `constraints.keepInside` from the
   TEMPLATE (`head_top`, `feet`, `knee_center` on the default preset,
   `src/framing/types.ts:282`), not from whichever strategy actually won.
   So even when a mannequin correctly falls through to the anchor-free
   `subject_fit` fallback, two low-confidence synthesized anchors can
   still get forced into frame and distort it:
   - `estimateHead`'s fallback #3 (`src/vision/analysis/anchors.ts:
     253-270`) synthesizes a `head_top` from the person box's top edge
     whenever ANY person-shaped region is detected at all — independent
     of whether a head was actually seen. This is the exact same
     mechanism Issue 1 already documents for half-face photos; here a
     mannequin's torso would be what triggers it instead of a person.
   - `feet`'s mask-derived fallback (`anchors.ts:485-495`) can anchor to
     a dress form's STAND/POLE rather than the garment hem, if matting
     absorbs it under dappled outdoor light.
   
   Confirmed NOT silently rejected: `src/services/generation-service.ts:
   200-216` renders a shot-type mismatch anyway (with a UI note), so
   this produces a visibly wrong render, not a skipped one.

3. **AI Extend's boundary vocabulary (Issue 7's documented gap)** — only
   `garment`/`skin`/`background` exist (`src/render/boundary-classify.ts:
   37`) — would classify a mannequin's stand as generic `background`,
   same seam mechanism Issue 7 already documents for a hanger.

**Fix plan** (extends Issue 1's and Issue 7's already-planned Phase 3
work, not new scope): (1) filter `enforceKeepInside`'s anchors by the
same confidence/trustworthiness check Issue 1's fix already calls for,
so a phantom `head_top` or stand-inflated `feet` can't override a
correctly-chosen anchor-free strategy; (2) extend that trustworthiness
flag to the person-box head fallback and mask-derived feet fallback
generally, not just the half-face case; (3) extend Issue 7's shot-type
gating to the boundary-classify vocabulary gap for `product_only` shots.

**Why this isn't being fixed blind right now**: `enforceKeepInside` and
`estimateHead`/`feet` anchor estimation are used by every template on
the default framing preset — changing their confidence handling without
a real photo to render before/after would be exactly the kind of
unverified change this program's own rules exist to prevent (Phase 3 is
already gated on `LOCAL_ISSUE_DIR` for this reason). This entry is
evidence strengthening Issue 1/7's priority, not a green light to patch
`solver.ts` against a thumbnail.

**Acceptance test** (once a real fixture is available): the mannequin
photo renders with the garment's actual hem as the bottom anchor (not a
stand/pole), no synthesized `head_top` forcing an unwanted zoom-out, and
a clean (non-visible-seam) AI-Extended background around the mannequin's
base.

**Status: Resolved, workaround confirmed by the user (2026-10-21) — no
code change.** Rather than fix `enforceKeepInside`'s phantom-anchor gap
blind (still no real mannequin fixture to verify against), the user
added a **"Flat lay"** rule to their real template's rule chain —
mannequin photos already land on `flat_lay` today (see point 1 above,
"a garment laid flat or on a ghost mannequin"). Configured with
`subject_top` as the vertical anchor and a `subject_top → subject_bottom`
(or `garment_top → garment_hem`) span for scale — the same anchors used
for the Issue 12 follow-up's "Product Only" rule, which never depend on
`head_top`/`feet` at all — this sidesteps the phantom-anchor gap entirely
rather than fixing it: consistent subject height and headspace without
ever touching a head-derived anchor. User confirmed this works on their
real photos. The underlying `enforceKeepInside` gap (point 2 above) is
still unfixed in the solver itself and would still affect anyone relying
on the *default* framing preset for a mannequin/flat-lay shot without a
dedicated rule — left as-is since the user's own case is resolved and no
real fixture exists yet to safely fix the general case.

---

## Issue 12 — Back-facing full-body shots misclassified `product_only` (reported 2026-10-21)

**Status: Fixed and verified against real catalog data.** Reported by the
user against their own real "test" template (tenant `tnt_YLUuygPCT0J72tRx`,
42-photo "compressed-images" import), via screenshots showing two
full-length back-view photos — hair covering the head, no face toward the
camera — landing on "Product only (backup rule)" with a warning that the
template's full/half-body rule would not apply.

**Root cause, confirmed against the real data, not assumed**: queried the
tenant's own `vision_analyses` table directly for the two named photos
(source hashes `bb1a1732f939ae5f19707…b36bad9` and
`18e1d164785c03324d385…1bf067`) and for all 42 photos in the batch
(`{"full_body":31,"half_body":6,"product_only":5}`). Of the 5
`product_only` results, 3 — including the two reported — had
`shoulders/hips/knees/ankles` ALL visible with `personHeightRatio` ~0.95–
0.96: a full figure in frame, just photographed from behind, so no face or
head keypoint resolved. The other 2 had every one of those signals `false`
(`personHeightRatio: 0`) — genuinely no person detected, correctly
`product_only`. `classifyShot`'s `anklesVisible && !headVisible` branch
(`src/vision/analysis/shot-type.ts`) tested only ankles-without-head and
could not tell these two cases apart.

**Fix**: within that branch, when `shouldersVisible && hipsVisible &&
kneesVisible` are also all true, classify `full_body` (confidence 0.7)
instead of falling through to `product_only` — the combined signal is what
separates a genuine lower-body-only crop (ankles visible, nothing above the
hip) from a back-facing full-length shot (the whole figure in frame, just
no head evidence). Verified with a synthetic regression suite
(`tests/vision/shot-type-back-facing.test.ts`, 4 tests) covering: the new
back-facing case, the genuine lower-body-crop case it must not swallow, a
partial-match case (shoulders+hips but no knees) that must still fall to
`product_only`, and the pre-existing head+ankles `full_body` path to
confirm it's unaffected. Full suite (441 tests) and `tsc --noEmit` both
clean.

**Caching implication, resolved**: `vision_analyses` rows are cached by
`(source_hash, engineVersion)` (`src/vision/model-registry.ts`'s
`ENGINE_VERSION`), so this classification fix does not retroactively
change already-analyzed photos on its own. User chose to force
re-analysis of all 42 photos in the "compressed-images" import (not just
the 3 affected ones, nor a global `ENGINE_VERSION` bump affecting every
tenant).

**Second request from the same report, also done**: "remove that head to
knees section by default" — the user confirmed this means the shared
`full_body_editorial` preset (`src/framing/types.ts`), not just their own
template's rule chain. Removed the `head_to_knees` strategy entirely from
that preset's `strategies` array. Consequence, by design: `head_to_feet`
is `full_body`-only, so `three_quarter`/`half_body` shots on this preset
no longer have a dedicated head-relative strategy and land on the
anchor-free `subject_fit` fallback (88% height, centered) instead of a
head-targeted crop. This affects every template built from
`full_body_editorial`, current and future — confirmed as the intended
scope before changing it. `tests/framing/solver.test.ts`'s two
`head_to_knees`-specific tests were rewritten against `head_to_feet`
instead (same trustworthiness-filter behavior, still covered) and a new
test added confirming `half_body` now falls straight to `subject_fit`.

**Follow-up after the user re-tested against the live app**: re-analysing
the real 42-photo batch surfaced three more problem photos the user
flagged directly — all investigated against the real data, not guessed:

1. **DSC09744.png — correctly classified `full_body`, but rendered with
   the `subject_fit` fallback instead of `head_to_feet`.** Root cause
   confirmed via the real `vision_analyses` payload: `feet`'s confidence
   (0.32) sits just under `head_to_feet`'s 0.35 floor, because `feet`'s
   confidence is inherited from the overall person-detection BOX score
   (`estimateFeet` in `anchors.ts`), not from the quality of the pixel row
   it measured — while `ankle_center`, a real, independently scored pose
   keypoint on the same photo, reads 0.57. Confirmed this is narrow
   (checked all 42 photos: exactly 1 match) before fixing. **Fixed**:
   `hasAnchor` in `src/framing/solver.ts` now also accepts `feet` when
   `ankle_center` independently clears the strategy's `minConfidence` —
   same reasoning already used for the `keepInside` fix above
   (`ankle_center` is independent evidence, not a guess). The strategy
   still measures the actual `feet` anchor's own position for geometry;
   `ankle_center` only unlocks the gate. 3 new tests in
   `tests/framing/solver.test.ts` (445 total, all passing).

2. **DSC09371.png and DSC09771.png — visibly full-length back-facing
   photos (confirmed by eye on the real screenshots) still classified
   `product_only`, with `hasPerson: false`.** Investigated with
   `scripts/debug-analyze-image.ts` against the real original files (not
   the tenant DB, not a guess): the pose/person detector (YOLOv8n-pose)
   returns **zero** person candidates at the default
   `personScoreThreshold` (0.35). Lowering the threshold to 0.01 surfaces
   a real candidate — box roughly matching the upper body, but scoring
   only **0.21** overall, with most head/face keypoints well below their
   visibility floor. Both photos have an unusually wide flared/feathered
   train that makes the segmentation-derived subject box nearly as wide
   as the frame (`subjectAspect` 1.41–1.55, far lower than a typical
   standing figure's own bounding-box aspect), which plausibly confuses a
   general-purpose person detector trained on more typical poses.
   **Not fixed yet — needs a decision, not a guess.** Two real options,
   each with a real cost:
   - Lower `VISION_PERSON_SCORE_THRESHOLD` (currently 0.35) tenant/site-
     wide — cheap, but unvalidated at this lower bar across every other
     tenant's photos; risks new false-positive "phantom person"
     detections on texture/pattern noise elsewhere, which the current
     threshold exists to prevent.
   - Add a segmentation-shape fallback to `classifyShot` for when the
     person detector finds nothing but segmentation strongly suggests a
     human silhouette — but a flat-laid garment with a dramatic spread
     can produce a very similar `personCoverage`/`subjectAspect`
     signature to these two real photos, and `classifyShot`'s own design
     principle (see the file's header comment) is specifically that
     bounding-box/aspect heuristics can't reliably tell those apart. Only
     2 of 42 real photos hit this, too few to validate a general rule
     against.
   Flagged to the user directly in chat rather than shipped silently;
   this entry exists so the decision and its reasoning aren't lost.

---

## Issue 13 — Head cropped off at top of frame still classified `half_body` (reported 2026-10-22)

**Status: Fixed and verified against real catalog data.** User flagged a
real photo (DSC08870.jpg) that should be `product_only` — no usable face
or head in the shot — but classified `half_body`. Confirmed directly
against the real `vision_analyses` payload: `hasFace: false`, but
`headVisible: true` — the keypoint path (see Issue 12's `headVisible` doc
comment, deliberately OR'd with face detection so a back-facing model
still counts) had fired on a head keypoint even though no actual face was
visible. The subject's `personHeightRatio` was ~1.00 with the box
touching BOTH the top and bottom edges of the frame: the head is cropped
off at the top of the shot, not turned away from the camera.

Checked before fixing, not assumed: queried every photo in the tenant's
catalog with the same "headVisible via keypoint only, no face" signature
(17 real photos). DSC08870.jpg was the **only** one touching the top
edge — every genuine back-facing full-body/half-body shot in the same
batch had the whole head comfortably inside the frame. `touchesTop` is
exactly the signal that tells a cropped head apart from a turned-away
one, and it doesn't touch any of the other 16 (which include several
real back-facing full-body mannequin/model shots this engine needs to
keep classifying correctly).

**Fix**: `headVisible`'s keypoint path in `computeSignals`
(`src/vision/analysis/shot-type.ts`) now also requires `!touchesTop` —
`ctx.face !== null || (headKeypointSeen && !touchesTop)`. A real face
detection still counts regardless of `touchesTop` (a detected face flush
against the top edge is still a real, visible face); the gate only
applies to the keypoint-only path. Covered by 4 new tests in
`tests/vision/shot-type-cropped-head.test.ts`: the cropped-head case
(now `product_only`), the same keypoint-only head NOT touching the top
edge (still `half_body`, confirming no over-rejection), a real face
detection touching the top edge (still counts, confirming the gate is
keypoint-path-only), and issue 12's no-head-evidence-at-all path
(confirmed unaffected). Full suite (450 tests) and `tsc --noEmit` both
clean.

**Separately noted during this investigation, not fixed here**: the same
hanger product shots from issue 7's `product_only` AI-Extend reversal
(`Red.png`, `Teal-Blue 2.png`, etc.) also show `headVisible: true,
hasFace: false` — but `touchesTop: false` for all of them, so this fix
does not touch them. Their `half_body` misclassification is the pose
model hallucinating a head/torso onto a shirt collar on a hanger, a
different root cause (a false-positive person detection, not a cropped
real one) that isn't addressed by this fix.

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

**Second correction, found later (2026-10-21) when a direct question
prompted actually checking the UI rather than just the solver**: the
editor UI itself already exists too, not just the mechanism it would sit
on. `src/components/builder/framing-controls.tsx`'s `ShotTypePicker`
lets someone assign `shotTypes` per framing rule, in both the builder's
Simple mode (`primary.shotTypes`) and Advanced mode (per-strategy, in a
reorderable rule list with live "active"/"n/a here" badges against the
current preview subject and missing-anchor warnings). Confirmed via
`git log --diff-filter=A` that this file was present in the repository's
very first commit — it predates every phase of both the multi-tenancy
work and this fix-issues program. **Phase 4, as originally scoped, is
already done** — there is no remaining gap between "per-shot-type
framing profiles" and what the template editor already offers, unless
the original requester wants something more specific than per-rule
`shotTypes` assignment (e.g. a guided wizard, or named presets bundling
several settings per shot type) that hasn't been described yet.

---

## Open items before Phase 2/3 can fully proceed

1. **`LOCAL_ISSUE_DIR`** — needed for real fixture-based reproduction and
   before/after evidence on issues 1, 2, 3, 7, 11 specifically
   (pixel-level comparisons). Still not provided as of 2026-10-19.
2. **Actual template IDs** behind the black-bar examples (issue 3) — to
   directly inspect their `background.color` values rather than reasoning
   about it in the abstract.
3. ~~Confirmation of whether `selectStrategy` consults shot type~~ —
   resolved: it does, via `strategy.shotTypes` (see Issue 1 above). The
   remaining precise fix for issue 1 is anchor-level trustworthiness
   (a `cropped`/`untrustworthy` flag on `head_top` when `headVisible` is
   false), which is independent of shot-type filtering and still needs to
   be built — not blocked on fixtures, a Phase 2 code task.
4. **Tried the tracker's own screenshot images as a fixture substitute —
   empirically confirmed they don't work.** New tools
   `scripts/debug-analyze-image.ts` and `scripts/debug-render-image.ts`
   (bypass tenant/DB/storage entirely — just the real vision engine and
   real framing solver against an arbitrary file) ran the pink-dress
   "half-face" screenshot's original-image cell through the actual
   pipeline. Two real, confirmed problems with using tracker screenshots
   as fixtures, not assumed: (a) the crop is **180×133px native**
   (upscaled for viewing) — the engine's own `quality.warnings` correctly
   flagged `low_resolution`, and the framing solver's resulting
   `max_upscale_clamped`/`crop_overflows_source` violations reflect that
   resolution problem, not necessarily the real reported bug; (b) the
   crop carries **baked-in UI chrome** from the tracker screenshot itself
   (a visible button icon, a scrollbar edge) that contaminates the
   subject region. The rendered output did NOT clearly reproduce issue
   1's "half-face becomes full-face" symptom — inconclusive, not a
   negative result, because the input itself isn't representative of a
   real upload. **Both debug scripts are kept** — they're exactly what's
   needed the moment a real fixture arrives, no further tooling work
   required at that point.
