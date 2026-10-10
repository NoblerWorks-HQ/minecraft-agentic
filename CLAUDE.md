# Minecraft Agentic Builder

## Overview
AI agents that build Minecraft worlds autonomously while you watch. Claude generates a
shared build plan, then one or more Mineflayer bots place blocks to realize it. The
multi-agent "crew" mode spawns 4 specialized bots (mason, carpenter, decorator,
landscaper) that collaborate, each with its own personality and chat. Built primarily as
content-creation / research material (time-lapse build footage).

## Environment
- **Status**: Experimental / research project
- **Live URL**: N/A (runs against a local Minecraft server)
- **Cloud**: None (calls the Anthropic API directly)
- **Requires**: Minecraft Java Edition server **1.20.1** (version must match - bots target 1.20.1), `online-mode=false`, command blocks enabled, and **bot usernames opped** (see Codebase Invariants)

## Tech Stack
- Runtime: Node.js (ESM)
- Minecraft: `mineflayer` + `mineflayer-pathfinder` + `prismarine-viewer`
- AI: pluggable via `src/providers.js` - Claude (`@anthropic-ai/sdk`), Gemini (`@google/generative-ai`,
  free tier), OpenAI (`openai`), or local Ollama (HTTP). No key -> procedural `src/library/` builds.
  Provider auto-detected from whichever key is set; override with `LLM_PROVIDER`.
- Config: `dotenv`

## Codebase Invariants

**Full text - each invariant with the incident that produced it, the proof, and the file that owns the rule now: [docs/INVARIANTS.md](docs/INVARIANTS.md).** Read it before changing build, fill, planning, the viewer/panel boot or the self-correction loops. **Change one, change the other in the same commit.** The rules:

- **`/fill` caps at 32,768 blocks per command and refuses anything larger SILENTLY - so nothing in this project may issue a raw `/fill` over a region it has not bounded.**
- **Three things make a model call fail while looking like the model "refused to answer", and both of the first two were live bugs on 2026-07-14.**
- **The crew is DATA (`src/profiles/*.json`), and the profile order IS the build timeline.**
- **`bot.chat()` on a disconnected bot is a SILENT no-op - it does not throw.**
- **Bots need a long keepalive timeout (`checkTimeoutInterval`, 120s - `MC_TIMEOUT`).**
- **Two panels cannot share a server.**
- **The bots build with `/setblock`, `/fill`, `/tp` - these require operator permission.**
- **The world is a RAISED superflat - solid rock from bedrock to a grass surface at y=63 - and the layer heights are load-bearing.**
- **Server version must be 1.20.1 - and 1.20.1 specifically, not just "any 1.20".**
- **Port 25565 open ≠ server ready.**
- **A disconnected bot places blocks into the void, silently.**
- **The world must be pacified or it eats the set.**
- **Roles overwrite each other: `/setblock` REPLACES, and the crew builds mason -> carpenter -> decorator -> landscaper.**
- **Build order is a TIMELINE, not just a z-order - and the site is aired out before anyone starts.**
- **A worker's block list may be REORDERED for the camera, but only within a y layer.**
- **The browser view must be bound to a bot that NEVER MOVES, or it renders a lie.**
- **How far the browser can see has TWO ceilings, and the lower one wins.**
- **The browser only learns where to point from a bot `move` event - and the camera bot never moves.**
- **A browser tab can silently miss ENTITY events, leaving builders drawn floating at stale mid-hop positions - so `startViewer()` re-announces every entity too.**
- **The view must be aimed at the SITE, not the plot.**
- **prismarine-viewer's BROWSER bundle never touches `window` - not even for THREE.**
- **The world outlives the process - and BOTH halves of the panel's site logic have now been burned by forgetting it.**
- **The world outlives the process; `state.sceneSites` does not.**
- **prismarine-viewer ships with a bug that makes EVERY STAIR BLOCK invisible in the browser - and this project patches it at install AND at startup.**
- **prismarine-viewer also DELETES a chunk's meshes the instant it slides out of the camera's radius - which made the plot's perimeter blink at every build start - and this project patches that too.**
- **The crew builds in PARALLEL (role i starts at i*3000ms, ~10 blocks/s), so "a later role overwrites an earlier role's block" is a RACE, not a technique - and the earlier role usually wins.**
- **`npm run e2e` (single bot) and `npm run replay` (full crew from cached plan) both verify the whole path - server, ops, viewer, block placement - against a live server with NO API key** - run one after changing bot connection, block placement, or the viewer.
- **`npm test` (`test/pick-ground.test.mjs`) covers click-to-place, the one feature that depends on prismarine-viewer's internals** - run it after touching the viewer proxy or the page.

Browser viewer and panel boot (`src/viewer.js`, `src/viewer-hook.js`, `scripts/web.js`):
- **The viewer never throws**: the `prismarine-viewer` import is dynamic and try/caught, so a missing/broken native `canvas` degrades to "watch in-game". `canvas` is an `optionalDependency` - `npm install` must never hard-fail on it. Opt-out `VIEWER=off` / `--no-viewer`; port `VIEWER_PORT`. `scripts/web.js` reverse-proxies it (HTTP + socket.io upgrade) so the panel is ONE url (`:8080`).
- **`scripts/web.js` listens and opens the browser BEFORE it boots anything.** Boot state travels inside `publicState()` (not a separate event, so `GET /status` resolves a late connect); the viewer iframe must NOT get a `src` until boot completes (`VIEWER_PORT` isn't chosen until then); anything added to the boot path belongs in `boot.steps`.
- **The 3D pane's preloader (`.vload`) is dismissed on real mesh progress (`window.__scenes`, pinned by `npm test`), never on the iframe's `load` event**, with a timeout so the viewer-unavailable fallback is never trapped behind it.

The two self-correction loops (`Crew.finishBuild()`), in this order - **fix what's broken, THEN ask whether it's any good**:
- **REPAIR (`src/repair.js`, free, always on)** re-places what never landed. **If a round fixes zero blocks, STOP** re-sending - escalate to the model with the reason the game refused each block.
- **REVIEW (`src/critic.js`, opt-in `CRITIC=on`)**: `src/shot.js` screenshots the live viewer; the model gets the pictures **next to `planDigest()`'s ASCII floor maps** - both halves are required. **The shot must be FRAMED**: `Crew.frameBuild()` re-parks the camera bot on the plan's bounding-box centre in all three axes, only after the last block has landed (pinned by `npm run test:loops`).
- **Every patch from a model is untrusted input; `normalizePatch()` is the only door** - plan-relative -> world-absolute, clamp in the RELATIVE frame first, validate block names against the 1.20.1 registry via `normalizeType`, coerce unknown roles, drop entries with no block type. `applyPatch` patches the PLAN, not just the world. `npm run test:loops` pins it.

The model designs in OPS, not blocks (`src/ops.js`, over `src/library/canvas.js` shared with the presets):
- **Every op is UNTRUSTED INPUT; `expandOps` is the only door** - clamps to the plot, refuses runaway ops, caps the total, coerces roles, drops unknown ops, validates block names against the 1.20.1 registry. Raw BLOCKS from a model become `put` ops through the same door.
- **If a rule needs two ops to AGREE, make it one op** (`window` carves and glazes in one move; `door` places both halves).
- **The op reference in the coordinator's prompt is GENERATED from the `OPS` table** - never hand-written.
- **`src/plans/reference-ops.json` is shown to the model on EVERY request** - audited by `npm run test:presets`, pinned by `npm run test:ops`.
- Model replies are parsed by `parseJsonish()` (`src/json.js`), the one fence-tolerant JSON extractor.

## Common Commands
```sh
npm install
npm run play           # THE one command: ensures server is up, shows the build menu
                       #   (13 library presets always free; with a key you can also type any idea)
npm run play "a wizard tower"   # skip the menu - the AI designs it (needs a provider key in .env)
npm run web            # browser control panel (scripts/web.js) - persistent crew + prompt/watch UI at :8080

# play orchestrates these (usable directly):
npm run server         # start local server via scripts/server.js (plain docker, NO compose plugin needed)
npm run server:stop    # stop (world kept); server:reset wipes; server:logs tails
npm run server:recreate # rebuild the CONTAINER, keep the world - the ONLY way a changed server
                       #   setting (VIEW_DISTANCE, MEMORY) takes effect; docker bakes -e at run
npm run replay         # full 4-bot crew from cached plan (no API key; assumes server up)
npm run e2e            # single-bot smoke test (no API key)
npm test               # click-to-place + agent loops + preset audit (no browser, no server, no key)
npm run test:loops     # repair/critic patch handling, crew profiles, blueprint format (no server)
npm run test:presets   # simulate every preset on the crew's real parallel schedule (no server)
npm run test:viewer    # does the BROWSER see what the crew built? (needs a server, no key)
npm run ops            # regenerate docker/ops.json (offline-UUID operators)
npm run record         # timelapse from a RUNNING `npm run web` (needs ffmpeg + playwright; scripts/record-demo.mjs):
                       #   camera ORBITED, never panned/dollied mid-build; refuses an unfinished build.
                       #   README hero media stays SCREENSHOTS (docs/media/crew-*.png) - footage reads worse

npm run setup          # onboarding: creates .env, checks Node/Docker/server
npm run demo "a castle" # single-agent build (uses your AI key, or the library if none)
npm run offline        # offline demo (no Docker / no key)
```
No key -> `src/library/` procedural builds; set GEMINI/ANTHROPIC/OPENAI key (or `LLM_PROVIDER=ollama`)
for custom prompts. In-game chat: `!build <description>`, `!stop`. Flags: `--sequential`, `--no-viewer`.
`docker-compose.yml` is an optional alternative to `scripts/server.js`.

## Doc map
- `docs/INVARIANTS.md` - full text of every invariant (digest above)
- `docs/ARCHITECTURE.md` - pipeline, design reasons, source map (one line per file)
- `docs/SETUP.md` - server setup, AI backends, viewer fallback, troubleshooting

## Safety Guardrails
### NEVER
- Commit `.env` or the Anthropic API key (only `.env.example` belongs in git).
- Point the bots at a production / online-mode server.

### ALWAYS
- Keep `ANTHROPIC_API_KEY` in `.env` (gitignored).
- Be mindful of token spend in `crew` mode (4 bots = more model calls).

## Docs stay current
- Update README, `docs/`, this CLAUDE.md and TODO.md **in the same commit** as the change that makes them wrong, never in a later cleanup. A stale doc is a bug.
