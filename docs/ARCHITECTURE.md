# Architecture

How a prompt becomes a building, and why the pieces are shaped the way they are.
This is the front door; the exhaustive version - every invariant, with the bug that
earned it - lives in [INVARIANTS.md](INVARIANTS.md) (digest in the root CLAUDE.md).

## The pipeline

```
 "a wizard tower"
       │
       ▼
 coordinator.js ──── providers.js ────▶ Claude / Gemini / OpenAI / Ollama
       │                                (no key? src/library/ presets instead)
       ▼
   a plan of OPS            one line each: walls, cyl, cone, door, window, scatter...
       │
       ▼
   ops.js expandOps()       THE DOOR: clamps coords to the plot, caps volume,
       │                    validates block names vs the real 1.20.1 registry,
       ▼                    drops what it can't repair
   blocks, per role
       │
       ▼
   crew.js ──▶ 4 worker bots (mason → carpenter → decorator → landscaper)
       │        building in parallel via /setblock over Mineflayer
       ▼
   finishBuild(): the two self-correction loops
       ├─ REPAIR (repair.js, free)      "did the world accept it?"  re-place, then
       │                                 ask the model about physically-refused blocks
       └─ REVIEW (critic.js, opt-in)    "is it any good?"  screenshot the live viewer,
                                         show a vision model the photos + the plan's
                                         ASCII floor maps, apply its patch
```

Everything a model returns - ops, repair patches, critic patches - is **untrusted
input** and passes through a validating door (`expandOps` or `normalizePatch`) before
touching the world. This is a hard rule: `/setblock` discards an invalid block name
*silently*, so an unvalidated hallucination doesn't fail, it just leaves a hole nothing
in the log explains.

## Why ops, not blocks

The model designs in primitives (`walls`, `cone`, `window`), the same ones the
procedural library uses - `src/library/canvas.js` expands both. One op line expands to
hundreds of blocks (~28x compression), so the model spends its output budget on design
instead of enumeration. Measured on the same prompt: 74 blocks scoring 3/10 became
2,773 blocks scoring 10/10. The deeper win is that classes of mistake become
impossible: a `walls` op cannot have gaps, `door` always places both halves, `window`
carves and glazes in a single move so glass can never float where a hole wasn't cut.

## The crew is data

Each role is one JSON file in `src/profiles/` (name, personality, materials, hard
rules). `src/profiles.js` feeds the same file to both consumers: the bots that act it
out and the coordinator prompt that must respect it. **Profile order is the build
timeline** - support before supported. The mason owns everything load-bearing because
the roles build in parallel and a block whose support arrives later gets deleted by
the game.

## The world

A local Dockerized Minecraft **1.20.1** server (`scripts/server.js`), offline-mode, on
a raised superflat (surface y=63; normal terrain puts caverns under every plot). Bots
need op to use `/setblock` - granted by mounting `docker/ops.json` keyed by offline
UUIDs, because the normal `OPS` env var does an online lookup that fails for offline
accounts. `src/world.js` pacifies the world (peaceful, no mob griefing, no command
feedback) because idle-loaded chunks spawn endermen that mine the set, and command
feedback from 4 opped bots re-broadcasting ~160 chat packets/s times everyone out.

The version pin is exact: prismarine-viewer supports 1.20.1 *specifically*, and even a
1.20.4 server shifts block-state IDs enough that the browser renders wrong blocks.

## The browser view

`src/viewer.js` serves a prismarine-viewer web view; `scripts/web.js` proxies it so
the whole control panel (prompt box, log, 3D view) is one URL. The view binds to a
dedicated **stationary camera bot** (`src/camera.js`) - never to a builder - because
the viewer reloads chunk columns every time its bot crosses a chunk boundary, and a
teleporting builder froze sections mid-build (the world was right; the picture lied).
`scripts/patch-viewer.js` patches two upstream viewer bugs at install time (all stair
blocks invisible; chunk meshes deleted at the render-radius edge) - `npm test` fails
if the patch is missing.

## Verification without an API key

The test pyramid runs with no server, no browser, no key:

| Command | What it proves |
|---|---|
| `npm test` | click-to-place against the real viewer bundle, patch/ops doors, preset audit, viewer patch present |
| `npm run test:presets` | every preset simulated on the crew's real parallel schedule with vanilla physics (pops, gravity, door support) |
| `npm run test:loops` | repair/critic patch handling, provider truncation-vs-refusal, crew profiles |
| `npm run e2e` / `npm run replay` | live server, real placement, no key |
| `npm run test:viewer` | the browser received every block the crew placed |

The recurring theme: this codebase's failures are *silent* (an unopped bot places
nothing, a disconnected bot chats into the void, an oversized `/fill` is refused
without a word), so almost every test re-reads the world or the wire instead of
trusting a success counter.

## Source map

One line per file (moved from the root CLAUDE.md, 2026-09-30).

```
src/
  bot.js          Mineflayer bot connection
  builder.js      block placement logic
  worker.js       individual worker bot with personality (loaded from profiles/)
  profiles/       THE CREW AS DATA - one JSON per role (name, phrases, materials, hard rules).
  profiles.js       Feeds both the bots and the coordinator's prompt. Order = build timeline.
  coordinator.js  plans + assigns work across the crew (via providers, or library if no key).
                  Its team paragraph is GENERATED from profiles/, and it shows the model a
                  matching library preset as a worked example (pickExample; FEWSHOT=off)
  crew.js         multi-agent orchestration + finishBuild() (the two loops below)
  repair.js       REPAIR loop: re-place what never landed; ask the model why the rest won't
                  stay. Also owns normalizePatch/applyPatch - the ONLY door for model patches
  critic.js       REVIEW loop: show the finished build to a vision model, apply its patch
  shot.js         headless-browser screenshots of the live viewer (Playwright, optional)
  digest.js       planDigest() - a plan as one ASCII floor map per y layer. The blueprint both
                  loops hand to the model; also the coordinator's few-shot example format
  agent.js        single-agent build planning
  providers.js    LLM abstraction (claude/gemini/openai/ollama) + vision (completeVision/
                  supportsVision) + auto-detect + library fallback. extractClaudeText/
                  extractOpenAIText are the truncation-vs-refusal decision, per provider
  fill.js         fillRegion/fillPlan/clearForPlan - /fill caps at 32768 blocks and is refused
                  SILENTLY above it, so the split lives here and everything clearing ground uses it
  json.js         parseJsonish() - the one fence-tolerant JSON extractor for model replies
  library/        procedural builds (13 presets: castle, wizard tower, cottage, lighthouse,
                  windmill, pagoda, ship, desert temple, observatory, mushroom house,
                  treehouse, hot-air balloon, rocket pad) used when no AI key is set
  viewer.js       browser viewer (prismarine-viewer) with graceful fallback; viewerUrl()
  viewer-hook.js  the three.js devtools handshake - the only way to reach the viewer's camera
                  from outside its bundle. Injected by web.js (click-to-place + the viewer
                  preloader's mesh-progress signal via __scenes) AND shot.js
  camera.js       the stationary bot the viewer renders from (a moving one freezes chunks)
  world.js        pacifyWorld() - peaceful, no mob griefing/fire/weather, no command-feedback spam
  preflight.js    friendly checks (API key set, server reachable) before connecting
  e2e-test.js     end-to-end smoke test (no API key needed)
  crew-replay.js  full crew build from a cached plan (no API key)
  index.js        interactive CLI
  demo.js / multi-demo.js / offline-demo.js   demos
  plans/          cached build plans (e.g. tavern.json)
scripts/play.js     `npm run play` - the one command (server-up + build)
scripts/web.js      `npm run web` - persistent-crew web control panel (http + SSE, embeds the viewer)
scripts/record-demo.mjs  `npm run record` - drives a headless browser against a running panel and
                    cuts the two-speed timelapse (build fast, reveal orbit slow). Camera is ORBITED,
                    never panned/dollied mid-build, and it refuses to publish an unfinished build.
scripts/server.js   start/stop/reset the Docker server (plain docker, no compose)
scripts/setup.js    `npm run setup` onboarding helper
scripts/gen-ops.js  `npm run ops` - generates docker/ops.json (offline UUIDs)
docker-compose.yml  optional compose alternative to scripts/server.js
docker/ops.json     prebuilt operator list (bots need op for /setblock)
```
