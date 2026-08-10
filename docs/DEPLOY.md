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

## AI Extend's inpaint service — a second, GPU-hosted service

The "AI Extend" background mode (per-template, opt-in — see the Framing/
Canvas tab in the Template Builder) calls `services/inpaint-service`, a
standalone FastAPI app that runs an SDXL inpainting model. Everything above
this section describes the main app alone; this is genuinely a second
deployable, not a feature flag inside the first one.

**Read this part first, same as the top of this file:**

- **This needs a real GPU.** Not the Render free plan, not the CPU
  DigitalOcean droplet the rest of this app runs on. SDXL inference on CPU is
  minutes per image — fine for the manual quality checks described below,
  completely wrong for anything serving real traffic. If you don't have GPU
  hardware yet, leave every template's background mode on "Plain" (the
  default) or one of the other CPU-cheap modes (`edge_extend`, `blur_extend`)
  — the rest of the app works exactly the same either way. AI Extend is
  additive, not load-bearing.
- **This endpoint must never be exposed to the public internet.** No
  authentication is implemented in this task — same posture as the main app's
  own "no login" warning above. It is meant to sit on a private/internal
  network where only the main app can reach it (a docker-compose internal
  network, a VPC, a firewall rule limiting the port to the main app's own
  host) — never a port forwarded to the public internet, never a hostname in
  public DNS.
- **They are two separate services on purpose.** The main app's own worker
  pool is sized for a laptop-class CPU box (see `src/config.ts`'s comments on
  `JOB_VISION_CONCURRENCY`/`JOB_RENDER_CONCURRENCY`); the inpaint service
  needs GPU memory and a completely different sizing story. Running them on
  the same box would mean either starving the GPU service of VRAM or starving
  the CPU workers of RAM, for no benefit — they don't share load, so there's
  nothing to gain from sharing a host.

### Running it on a small/laptop GPU

Between "no GPU at all" and "a proper GPU host" there is a common middle
case: a workstation or laptop with a modest NVIDIA card (4–6 GB VRAM). That
**will** run this feature usefully, just not with the production checkpoint —
SDXL inpainting needs roughly 8–10 GB of VRAM, and the standard workaround
(CPU offload) wants several GB of free system RAM that such machines
generally don't have spare either.

Point the service at an SD2 inpainting checkpoint instead — smaller
architecture, ~1.7 GB in fp16, same commercial-safe OpenRAIL++-M licence:

```
INPAINT_DEVICE=cuda
INPAINT_MODEL_ID=stabilityai/stable-diffusion-2-inpainting
INPAINT_MAX_DIM=768
```

Seconds per image rather than minutes, and enough to judge whether the
extended backdrops are actually good before spending anything on hardware.
Treat it as validation, not production: quality is a clear step below SDXL.
Full details in `services/inpaint-service/README.md`.

### Quality testing before you have a GPU

`INPAINT_DEVICE=cpu` runs the real model, the real pipeline, on CPU — no GPU
required, no mocking. It exists specifically to answer "does the output
actually look right" on a handful of real photos before committing to GPU
hardware:

```
cd services/inpaint-service
pip install -r requirements.txt
INPAINT_DEVICE=cpu uvicorn main:app --host 0.0.0.0 --port 8001
```

Then point the main app's `.env.local` at it:

```
INPAINT_SERVICE_URL=http://localhost:8001
INPAINT_DEVICE=cpu
```

Both apps read `INPAINT_DEVICE` independently — the Python service to decide
which device to load the model onto, the Node app to hard-cap its own
`INPAINT_JOB_CONCURRENCY` at 1 (see `src/config.ts`) so it doesn't fire a
second inpaint request at a service that can only usefully do one at a time.
Set it the same on both when testing this way.

Expect minutes per image, and expect the service to log a loud warning on
startup reminding you this isn't a production configuration. That warning is
not decorative — **never point a deployed app's `INPAINT_SERVICE_URL` at an
instance running in this mode.**

### Production: docker-compose, main app + GPU inpaint service

Once GPU hardware exists (a GPU-enabled cloud VM, a machine with an NVIDIA
card and the NVIDIA driver + Container Toolkit installed), the two services
run side by side, main app talking to the inpaint service over the compose
network by service name — never a publicly routable address:

```yaml
# docker-compose.yml — illustrative; adjust volumes/ports to your host.
services:
  vision-studio:
    build: .
    ports:
      - "3000:3000"          # the only port that should ever reach the public internet
    volumes:
      - vision-studio-data:/app/data
    environment:
      INPAINT_SERVICE_URL: http://inpaint-service:8001   # internal DNS name, not a public host
      INPAINT_DEVICE: cuda
      JOB_VISION_CONCURRENCY: "1"
      JOB_RENDER_CONCURRENCY: "1"
      INPAINT_JOB_CONCURRENCY: "2"
    depends_on:
      - inpaint-service

  inpaint-service:
    build: ./services/inpaint-service
    # No `ports:` entry — not reachable from outside the compose network at
    # all, only from `vision-studio` over the internal DNS name above.
    volumes:
      - inpaint-models:/models   # several GB of weights; keep across restarts
    environment:
      INPAINT_DEVICE: cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

volumes:
  vision-studio-data:
  inpaint-models:
```

`docker compose up` builds and starts both. The first start on the
inpaint-service side downloads the model (several GB) into the `inpaint-models`
volume — that happens once, not on every restart.

If your GPU host is a *separate* machine from the one running the main app
(common — a CPU droplet for the app, a GPU instance elsewhere for
inference), replace the compose internal DNS name with that machine's
private/internal IP or hostname reachable only over a VPC or VPN — still
never a public one — and make sure whatever firewall sits in front of port
8001 allows only the main app's host, nothing else.
