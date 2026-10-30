# Feature Catalogue

The canonical list of what a user of Minecraft Agentic Builder can see and do, verified against the code.
Update this file in the same commit as any user-visible change. How it works lives in [ARCHITECTURE.md](ARCHITECTURE.md); setup and troubleshooting in [SETUP.md](SETUP.md); the rules behind each feature in [INVARIANTS.md](INVARIANTS.md).
Status: experimental open-source demo. It runs locally against your own Minecraft 1.20.1 server; there is no hosted version.

## Ways to run it

- **Browser control panel** (`npm run web`, [scripts/web.js](../scripts/web.js)) - one page at `http://localhost:8080` with the prompt box, presets, scenes, click-to-place, live build log and the embedded 3D view. Starts the server and the crew, opens the browser first and shows each boot step ticking over; the crew stays connected between builds.
- **Terminal menu** (`npm run play`, `npm run play "a wizard tower"`, [scripts/play.js](../scripts/play.js)) - ensures the server is up, shows the build menu (or skips it for a typed idea), and serves a read-only 3D view at `:3000`. Flags `--sequential` (one bot at a time) and `--no-viewer`.
- **Interactive CLI with in-game chat** (`npm start`, [src/index.js](../src/index.js)) - prompt after prompt from the terminal, and `!build <description>` / `!stop` typed in Minecraft chat. Needs a model key.
- **Single-bot demo** (`npm run demo "a hut"`, [src/demo.js](../src/demo.js)) - one bot plans and builds. Needs a model key (`requireApiKey()` stops it otherwise).
- **Crew demo** (`npm run crew`, [src/multi-demo.js](../src/multi-demo.js)) - the four-bot crew on a fixed list of demo builds. Needs a model key.
- **Cached-plan demo** (`npm run offline`, [src/offline-demo.js](../src/offline-demo.js)) - the crew builds a cached plan from `src/plans/` (default `tavern.json`) with no API key. It still connects to a Minecraft server at `MC_HOST`/`MC_PORT`.
- **Watch in the real game** - Direct Connect to `localhost` from Minecraft Java 1.20.1; browser and game are views of the same world and work at the same time.

## The control panel

- **Prompt box** (`POST /build`) - type any idea and the AI designs it. Live only when a provider key is set; otherwise the library presets are the menu.
- **Library presets** ([src/library/index.js](../src/library/index.js), primitives in [src/library/canvas.js](../src/library/canvas.js)) - thirteen procedurally generated builds, always free with no key or network: castle, wizard tower, cottage, lighthouse, windmill, pagoda, ship, temple, observatory, mushroom house, treehouse, hot-air balloon, rocket pad. Sizes, materials and details are randomized per run.
- **Scenes** (`POST /background`, `SCENES` in [scripts/web.js](../scripts/web.js)) - Plains, Beach, Desert, Mountains, Snowy, Jungle, Cherry Grove. Each is a constructed flat platform with its own biome and backdrop on a permanent plot, built once (~10s) and then reached by teleport, even after a restart.
- **Click-to-place** (`POST /place`, `POST /place/auto`) - click the ground in the 3D view and the crew outlines the build's footprint there; reset to the next grid slot with auto placement.
- **Clear ground** (`POST /clear`) - bulldozes the build area back to flat ground, including builds left from earlier sessions; scene decoration outside the area stays.
- **Critique it** checkbox - opts one build into the visual review below.
- **Live log and status** (`GET /events`, `GET /status`) - streamed build log, crew chat and boot state; a late page load picks up the current state.
- **Embedded 3D view** (`/viewer/`) - prismarine-viewer reverse-proxied same-origin (HTTP and socket.io), so the panel is one URL. A preloader tracks real mesh progress, with a fallback to "watch in-game" if the viewer is unavailable.
- **Request guard** ([src/http-guard.js](../src/http-guard.js)) - POSTs must come from the panel's own page on a loopback host (blocks cross-site form posts and DNS rebinding), since the panel spends your model key. Listens on `127.0.0.1` by default (`BIND`).

## The crew

- **Four builder bots** ([src/crew.js](../src/crew.js), [src/worker.js](../src/worker.js)) - Rocky (mason), Woody (carpenter), Fancy (decorator) and Bloom (landscaper) split one shared plan, build in parallel with staggered starts, and chat in character while they work.
- **Crew as data** ([src/profiles/](../src/profiles/), loaded by [src/profiles.js](../src/profiles.js)) - one JSON file per role (name, rules, materials, phrases) feeds both the bots and the AI prompt; profile order is the build timeline. `architect.json` (Archie) places no blocks and is kept for single-agent demos. `PROFILES_DIR` swaps in a different crew.
- **Camera bot** ([src/camera.js](../src/camera.js)) - Cam, a fifth bot that never moves during a build, is what the browser view renders from, so the picture matches the world.
- **Site-walking order** - each role's blocks are sorted into layers and walked nearest-neighbour, bottom-up, so bots move along the course they are laying instead of teleporting across the plot.
- **Pacified world** ([src/world.js](../src/world.js)) - peaceful, permanent noon, no mob griefing, fire or weather, so the set is not damaged between builds.

## AI design

- **Pick your AI** ([src/providers.js](../src/providers.js)) - built-in library (default, free), Google Gemini (free tier), Anthropic Claude, OpenAI, or local Ollama; auto-detected from whichever key is in `.env`, forced with `LLM_PROVIDER`.
- **Coordinator** ([src/coordinator.js](../src/coordinator.js)) - turns a prompt into a build plan and splits it across the crew; shows the model a matching preset as a worked example (`FEWSHOT`, on by default) and [src/plans/reference-ops.json](../src/plans/reference-ops.json) on every request.
- **Build ops** ([src/ops.js](../src/ops.js)) - the model designs in shapes (`walls`, `floor`, `cyl`, `disc`, `ring`, `cone`, `box`, `door`, `window`, `punch`, `scatter`, `put`), each expanding to many blocks. `expandOps` clamps to the plot, refuses runaway ops, caps the total and checks every block name against the 1.20.1 registry, repairing near-misses.
- **Single-agent planner** ([src/agent.js](../src/agent.js), placement in [src/builder.js](../src/builder.js)) - the one-bot path used by `npm start` and `npm run demo`.
- **Model reply parsing** ([src/json.js](../src/json.js)) - one fence-tolerant JSON extractor for every model reply.

## Self-checking builds

- **Repair pass** ([src/repair.js](../src/repair.js), always on) - after the last block, re-reads the world, re-places what never landed, and with a key shows the model each block the game still refuses, with the reason, so it patches the plan. `REPAIR=off` keeps the re-place but skips the model.
- **Visual review** ([src/critic.js](../src/critic.js), opt-in `CRITIC=on` or the panel checkbox) - [src/shot.js](../src/shot.js) photographs the framed build from the live viewer, and a vision model scores it next to the plan's ASCII floor maps ([src/digest.js](../src/digest.js)), then patches what it found. Costs a model call; needs Playwright. Ollama needs `OLLAMA_VISION_MODEL`.
- **Safe clearing** ([src/fill.js](../src/fill.js)) - every clear is split into `/fill` commands under Minecraft's silent 32,768-block cap.

## Server and setup

- **One-command server** (`npm run server`, `server:stop`, `server:reset`, `server:recreate`, `server:logs`, [scripts/server.js](../scripts/server.js)) - runs a Minecraft 1.20.1 server in plain Docker (no compose plugin) with the raised superflat world, ops and command blocks set; the world is kept on disk. [docker-compose.yml](../docker-compose.yml) is an optional alternative.
- **Bot operators** (`npm run ops`, `npm run ops -- Name`, [scripts/gen-ops.js](../scripts/gen-ops.js)) - writes [docker/ops.json](../docker/ops.json) with each bot's offline UUID so the bots can use `/setblock`, `/fill` and `/tp`.
- **Onboarding** (`npm run setup`, [scripts/setup.js](../scripts/setup.js)) - creates `.env` and checks Node, Docker and the server.
- **Friendly preflight** ([src/preflight.js](../src/preflight.js), connection in [src/bot.js](../src/bot.js)) - clear errors for a missing key or unreachable server; long keepalive (`MC_TIMEOUT`).
- **Viewer with graceful fallback** ([src/viewer.js](../src/viewer.js), [src/viewer-hook.js](../src/viewer-hook.js)) - if the native `canvas` module is missing, the bots still build and you watch in-game. `VIEWER=off` disables it.
- **Viewer patches** ([scripts/patch-viewer.js](../scripts/patch-viewer.js), run on `postinstall` and checked by `npm test`) - fixes two prismarine-viewer bugs: invisible stair blocks and chunk meshes dropped at the camera's edge.

## Content capture

- **Timelapse recorder** (`npm run record`, [scripts/record-demo.mjs](../scripts/record-demo.mjs)) - drives a headless browser at a running `npm run web`, builds a preset on a scene (`--preset=`, `--scene=`), and writes a date-stamped `.mp4` and animated `.webp` (fast build, then a slow orbit). Refuses an unfinished build. Needs `ffmpeg` and Playwright Chromium.

## Tests and gates (no API key needed)

- **Unit suite** (`npm test`) - [test/http-guard.test.mjs](../test/http-guard.test.mjs), [test/pick-ground.test.mjs](../test/pick-ground.test.mjs) (click-to-place), [test/agent-loops.test.mjs](../test/agent-loops.test.mjs) (`npm run test:loops`), [test/ops.test.mjs](../test/ops.test.mjs) (`npm run test:ops`), [test/preset-audit.test.mjs](../test/preset-audit.test.mjs) (`npm run test:presets`, simulates every preset on the crew's parallel schedule), plus the viewer patch check.
- **Live-server checks** - `npm run e2e` ([src/e2e-test.js](../src/e2e-test.js), one bot builds the cached tavern), `npm run replay` ([src/crew-replay.js](../src/crew-replay.js), full crew from a cached preset), `npm run test:viewer` ([test/viewer-sync.test.mjs](../test/viewer-sync.test.mjs), does the browser see what was built).
- **CI** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) - `npm ci`, `npm test`, `npm audit --audit-level=high --omit=dev`.
- **Local push gate** ([scripts/check-ci-local.mjs](../scripts/check-ci-local.mjs), `.githooks/pre-push`) - runs the CI gate at `git push` unless Actions already has a recent green push run; [scripts/ci-local-verdict.sh](../scripts/ci-local-verdict.sh) answers whether that gate already passed for this exact code.
- **TODO budget** ([scripts/todo-budget.mjs](../scripts/todo-budget.mjs), `.githooks/pre-commit`) - keeps `TODO.md` to open items under a fixed size, archiving closed work.
