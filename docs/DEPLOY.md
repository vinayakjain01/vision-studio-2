# Deploying to Render

## Read this part first

This app was built to run on one machine, for one person, with a local SQLite
file and local photos on disk — not as a hosted multi-user service. Deploying
it on Render's **free** plan (what this guide sets up) means three specific
things, not just "it might be slow":

1. **Nothing survives a restart.** Free-plan services have no persistent
   disk. Render also puts a free service to sleep after ~15 minutes with no
   traffic and wipes its filesystem on the next wake-up. Every import, every
   generated image, the whole SQLite database — gone, every single time the
   service goes idle and wakes back up. This isn't a one-off migration risk,
   it's the steady-state behaviour of this plan.
2. **No login.** Anyone with the URL can view, generate, or delete whatever
   is in the catalog at that moment. Fine for a team trying the tool out;
   not fine if the URL ever reaches beyond the team.
3. **Not enough RAM to know if it'll even run vision analysis reliably.**
   The free plan is smaller than anything this app has been tested on. Basic
   browsing should work; importing photos and generating creatives — the
   actual point of the app — is the part most likely to hit the ceiling.

None of that is a mistake in the setup below — it's what "free" costs on
Render for an app shaped like this one. When it stops being worth the
trade-off, moving to a paid Render plan (persistent disk) or to your existing
DigitalOcean server is a config change, not a rewrite — the same Dockerfile
runs either place.

## What you're deploying

- **render.yaml** (repo root) — a Render "Blueprint": one file that describes
  the whole service, so Render can set it up without you clicking through
  individual settings. It uses Render's own native Node build environment —
  not the Dockerfile below — because a custom Docker image built fine but
  crashed `better-sqlite3` at start-up on Render specifically (a native
  binary mismatch not diagnosable from outside their infrastructure). Render's
  native environment is built to support npm packages with native addons
  correctly, which a hand-rolled Dockerfile can't fully guarantee.
- **Dockerfile** (repo root) — not used by this Blueprint. Kept for the
  DigitalOcean fallback in "If it doesn't hold up" below, where you control
  the exact host and this class of mismatch doesn't apply.

Both are already committed and pushed to `vinayakjain01/VisionStudio` on
GitHub.

## Steps

1. **Create a Render account** (or sign in) at [render.com](https://render.com) —
   free, no card required for the free plan.
2. **New → Blueprint.**
3. **Connect the `vinayakjain01/VisionStudio` GitHub repository.** Render
   reads `render.yaml` automatically and shows you the one service it
   defines (`vision-studio`, free plan, native Node).
4. **Apply.** Render runs `npm ci && npm run models:fetch && npm run build` —
   expect the first build to take several minutes (installing dependencies,
   downloading ~160MB of model weights, running `next build`).
5. Render gives you a URL: `https://vision-studio-xxxx.onrender.com` (the
   exact suffix depends on name availability). That's what you share with
   the team.

## After it's up

- **First request after any idle period takes 30–60 seconds** — that's
  Render waking the container from sleep, not the app hanging. Anyone on the
  team hitting a blank/slow load first thing should just wait it out once.
- **Test the actual point of the app before trusting it**: import a small
  test folder (a handful of photos, not your real catalog — see the data-loss
  note above) and try generating one image. If analysis or generation fails
  or the service falls over, that's the free plan's RAM ceiling, not a bug —
  see "If it doesn't hold up" below.
- Check **Settings → Environment** in the Render dashboard if you ever need
  to confirm `JOB_VISION_CONCURRENCY` / `JOB_RENDER_CONCURRENCY` /
  `VISION_ORT_THREADS` are still `1` — they're set by `render.yaml`, but
  worth knowing where to look.

## If it doesn't hold up

You mentioned having a DigitalOcean server as a fallback — the same
`Dockerfile` in this repo runs there unchanged (`docker build` + `docker run`,
or DigitalOcean's App Platform pointed at the same GitHub repo). The only
things that would change are:

- Add a persistent volume mounted at `/app/data` — the entire point being
  that the database and photos stop resetting on restart.
- Give it more RAM than Render's free tier — 2GB is a reasonable starting
  point given what this session measured locally; raise
  `JOB_VISION_CONCURRENCY` / `JOB_RENDER_CONCURRENCY` above `1` only after
  confirming the box has real headroom to spare, the same reasoning as
  `src/config.ts`'s own comments.

Ask when you're ready to move — it's a smaller change than this first
deploy was.

## AI Extend — Cloudinary generative fill

The "AI Extend" background mode (per-template, opt-in — see the Framing or
Canvas tab in the Template Builder) calls Cloudinary's generative-fill API to
extend a photo's own backdrop into the empty canvas around it. Everything
else in this app runs offline; this is the one outbound dependency, and the
one that costs money.

**Two things to know before turning it on:**

- **Every generative fill spends paid Cloudinary credits.** Results are
  cached as derived assets keyed by (photo hash, padding, prompt), so
  re-rendering the same photo with the same template never re-calls the API —
  but a new photo, a changed canvas, or an edited backdrop prompt is a new
  billable derivation. A large first-time batch is a real charge.
- **Nothing degrades silently.** If credentials are missing, credits are
  exhausted, or Cloudinary rate-limits, the `background_fill` job fails
  visibly and the render waits rather than quietly falling back to a flat
  colour. Auth and credit failures are parked immediately rather than
  retried, since no number of retries fixes either.

### Setup

Add to `.env.local` (never committed — see `.gitignore`):

```
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

That is the whole deployment story: no second service, no GPU host, no
docker-compose changes. The main app calls Cloudinary directly, so the same
single container described above still runs everything.

`CLOUDINARY_JOB_CONCURRENCY` (default 2) bounds how many calls run at once.
It is deliberately separate from `JOB_RENDER_CONCURRENCY`: this workload
waits on a remote, rate-limited, billed API rather than local CPU, so sizing
it off cores — or letting it borrow render slots — would be wrong in both
directions.

The Template Builder shows whether Cloudinary is configured at the point
where AI Extend is selected, so a missing credential surfaces before a batch
runs rather than as a pile of failed jobs afterwards.
