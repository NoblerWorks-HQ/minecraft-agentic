# Codebase Invariants

> Canonical full text. Moved out of the root `CLAUDE.md` on 2026-09-06 for the
> session context budget (that file loads in full every session; it was
> 46,779 bytes). It carries each invariant with the incident that produced it, the proof, and the file that owns the rule.
> The viewer/boot, self-correction-loop and ops sections followed on 2026-09-30.
> The CLAUDE.md digest keeps the RULES; this doc keeps the detail and the
> evidence they came from. **Change one, change the other in the same commit.**

---

# Codebase Invariants
- **`/fill` caps at 32,768 blocks per command and refuses anything larger SILENTLY - so nothing
  in this project may issue a raw `/fill` over a region it has not bounded.** The panel learned
  this on `/fillbiome` (a naive 32x32x66 tiling was 67k per command, so four of every five were
  dropped and only a scene's thin edge strips landed), but `Crew.executeBuild`'s own "let me
  clear the area first!" kept the same shape - ONE fill over the plan's whole bounding box. Every
  preset happens to fit (the castle is the largest at 20,808), which is why it survived; an ops
  build may legally span the plot to y=48, which is **122,112 blocks**, so the clear vanished on
  exactly the builds that most needed it - while the coordinator's prompt had promised the model
  a site "bulldozed to bare earth, INCLUDING the grass". Proved live 2026-07-29 by marking both
  corners of a 122,112-block region: after the old single `/fill`, **both markers still stood**;
  after `fillRegion` (4 commands) both were air. `src/fill.js` owns the rule now - it splits on
  VOLUME (halve the longest axis) rather than tiling into 32^3 cubes, so a long thin box like a
  shore ring stays one command - and `crew.js`, `demo.js`, `offline-demo.js` and `web.js`
  (`fillRegion`, `fillBiome`, `levelSite`) all go through it. Pinned by `npm run test:loops`.
- **Three things make a model call fail while looking like the model "refused to answer", and both
  of the first two were live bugs on 2026-07-14.** (The third, the Claude/OpenAI half, was found
  by inspection on 2026-07-29 - the invariant had only ever been enforced for Gemini.)
  were live bugs on 2026-07-14. Check them BEFORE you debug a prompt.** (1) **A Gemini model can die
  on its own, without taking the key with it.** Google retires and overloads free-tier models
  per-MODEL: our pinned default `gemini-flash-latest` 503'd "high demand" for hours while the same
  key answered instantly on other models, `gemini-2.5-flash` was closed to new keys ("no longer
  available to new users"), and `gemini-2.0-flash` carried a free quota of 0. So `completeGemini`
  walks `GEMINI_FALLBACKS` until something answers, and remembers the winner for the process
  (`geminiWorking`) so the dead-model probe costs one call, not one per build. `providerLabel()`
  reports the model that ANSWERED - the configured name is, by then, the one model known not to
  work. **`geminiModelIsUnavailable()` is the whole retry-vs-fail decision**: a 400/403 is our bug
  and must surface at once, not be retried on three models and reported as Google's fault. Pinned by
  `npm run test:loops`. (2) **A reasoning model spends `maxOutputTokens` on THINKING before it writes
  a single character**, so a budget that was ample for a one-shot model runs out mid-JSON and the
  reply is a 200 carrying half an object. Every parser downstream then reports the same useless
  thing: "the model did not return valid JSON" - which reads as a refusal and is actually a
  truncation. That is exactly how the repair + critic loops failed on 4096 tokens while the
  coordinator, on 16384, sailed through. All three JSON calls now ask for 16384 (a CEILING, not a
  spend - a short patch still costs a short patch), and `completeGemini` raises `finishReason=
  MAX_TOKENS` as its own error that says *truncated*, not *refused*. (3) **The same truncation was
  unguarded on Claude and OpenAI for as long as the invariant existed** - only Gemini ever checked.
  `extractClaudeText` / `extractOpenAIText` (`providers.js`, both exported and pinned by
  `npm run test:loops`) now raise `stop_reason=max_tokens` / `finish_reason=length` as *truncated*,
  and a Claude `stop_reason=refusal` as a refusal - checked BEFORE the content is read, since a
  decline is a 200 with empty content. **And `content[0]` is NOT the text**: the Claude default is
  now `claude-opus-5` (the old pin, `claude-sonnet-4-20250514`, was deprecated and this path had
  never once run against the real API), thinking is ON BY DEFAULT on that family, so the first
  content block is a `thinking` block and the old `res.content[0].text` would have handed
  `undefined` to every parser downstream. Take the first block whose `type === 'text'`. Note also
  that `max_tokens` there caps thinking PLUS the answer.
- **The crew is DATA (`src/profiles/*.json`), and the profile order IS the build timeline.** A role
  used to be defined twice - a `PERSONALITIES` table in `worker.js` and a hand-written team paragraph
  in the coordinator's system prompt - and the two drifted: the prompt never learned any of the rules
  the crew had been burned by. Now one JSON file per role feeds BOTH (`src/profiles.js`: `teamBrief()`
  builds the prompt, `buildRoles()` builds the crew), so a role's hard rules ("anything load-bearing
  belongs to the mason", "a window is a HOLE in someone else's wall, never glass written over it")
  reach the model that has to obey them. `order` is not cosmetic - it is the support-before-supported
  timeline, and `test/agent-loops.test.mjs` asserts it still matches the library's `buildOrder`.
  Idea from mindcraft; `PROFILES_DIR` swaps the whole crew.
- **`bot.chat()` on a disconnected bot is a SILENT no-op - it does not throw.** Everything the
  bots do to the world (`/setblock`, `/fill`, `/fillbiome`, `/tp`) is a chat command, so a bot that
  dropped keeps "working" into the void: a scene builds with zero blocks placed, a marker never
  appears, `blocksPlaced` still counts up, and the log stays clean. Every code path that issues a
  command must call `Crew.ensureAlive()` first (`crew.executeBuild` does; `scripts/web.js` does it
  via `ensureCrew()`, and guards each individual command with `assertLead()` so a lead that drops
  MID-scene raises instead of evaporating - `buildScene` then retries; every fill is idempotent).
  `Worker.alive` tracks liveness off the `end` event. If something "succeeds" but the world didn't
  change, this is almost always why - check for a `duplicate_login` or `keepAliveError` kick in the
  log before debugging the geometry.
- **Bots need a long keepalive timeout (`checkTimeoutInterval`, 120s - `MC_TIMEOUT`).** Mineflayer's
  30s default assumes a survival bot on an idle server. A scene build is thousands of `/fill` and
  `/fillbiome` commands, each rewriting and re-sending whole chunk columns, and a server that busy
  starves its own keepalives long before it stops working - so the bots "time out" against a
  perfectly healthy server, and then (see above) silently no-op. Building all 7 scenes back-to-back
  dropped 4 bots on the 30s default and 0 at 120s.
- **Two panels cannot share a server.** The bots have fixed usernames, so a second `npm run web`
  kicks the first one's crew with `duplicate_login` and the first panel then silently no-ops (see
  above). Kill stale panels before starting one: `pkill -f 'scripts/w[e]b\.js'` - and note the
  bracket trick, a plain `pkill -f scripts/web.js` matches its own shell and kills the caller.
- **The bots build with `/setblock`, `/fill`, `/tp` - these require operator permission.** On a
  fresh dedicated server the bots connect but silently place nothing until opped. Because the server
  is `online-mode=false`, the itzg `OPS` env var does NOT work (it does an online PlayerDB lookup that
  fails for offline usernames and prevents the server from starting). Instead `docker-compose.yml`
  mounts `docker/ops.json`, a prebuilt ops list keyed by each bot's **offline UUID** (v3 MD5 of
  `OfflinePlayer:<name>`). Regenerate with `npm run ops` (`scripts/gen-ops.js`); a custom `MC_USERNAME`
  must be added (`npm run ops -- Name`) and the server restarted. #1 "why isn't it building" gotcha,
  verified end-to-end 2026-07-10 (full crew built 252 blocks in-world, no manual op).
- **The world is a RAISED superflat - solid rock from bedrock to a grass surface at y=63 - and
  the layer heights are load-bearing.** Normal terrain generates caverns under every plot, and
  nothing in this project ever goes underground (the scenes' "solid encased base" only papered
  over the caves directly beneath a platform), so `scripts/server.js` + `docker-compose.yml` set
  `LEVEL_TYPE=FLAT` with explicit `GENERATOR_SETTINGS` layers. Do NOT simplify to a default
  superflat: its surface sits at y=-60, and prismarine-viewer never meshes sections below y=0
  (worldrenderer loops y 0..255), so the browser renders empty sky. The surface must also stay
  below the panel's `SEA_Y=62`+1 so shore scenes flood correctly (y=63 = exactly 1 above the
  waterline). Generator settings apply only at world CREATION - changing them needs
  `npm run server:reset` (which deletes every built plot; scenes reconstruct on next visit).
  Switched 2026-07-14 ("underground caverns are unnecessary").
- **Server version must be 1.20.1 - and 1.20.1 specifically, not just "any 1.20".** Two reasons:
  (1) the itzg image defaults to *latest* Minecraft; unpinned = bot connect mismatch. (2) prismarine-viewer
  supports 1.20.1 EXACTLY (its supported list jumps 1.20.1 -> 1.21.1); running 1.20.4 shifts block-state IDs
  vs the viewer's 1.20.1 assets, and the browser view renders wrong blocks (stone bricks showed as beehives,
  gray_concrete as gravel - found 2026-07-11 via a rendered-palette screenshot test). The server pin lives in
  `scripts/server.js` + compose; the bot pin in `src/bot.js`; both overridable with `MC_VERSION` (don't).
- **Port 25565 open ≠ server ready.** Docker's proxy binds the port the instant the container starts,
  minutes before a fresh world finishes generating - a bot connecting then dies with `EPIPE`.
  `scripts/server.js` therefore waits for the `]: Done (…s)!` line in the container logs (scoped to the
  current boot via `StartedAt`) before declaring the server up. Found 2026-07-11 via `server:reset` + play.
- **A disconnected bot places blocks into the void, silently.** `bot.chat()` on an ended mineflayer
  bot is a no-op that neither throws nor warns, while `blocksPlaced` keeps counting - so a worker that
  times out mid-build produced a half-built house AND a cheerful "Build complete! 779 blocks". Because
  each role's blocks go out in list order and the roof is the TAIL of the carpenter's list, the symptom
  was always the same: a roofless house. `Worker` now tracks `alive` (set false on `end`) and
  `buildBlocks` throws if it dies; `Crew.ensureAlive()` reconnects dead workers before a build; and
  `Crew.verifyBuild()` re-reads the world afterwards and logs any blocks that never landed. Found
  2026-07-12. Never trust the placed-block counter as proof a build finished - trust `verifyBuild`.
- **The world must be pacified or it eats the set.** Idle bots keep the plot's chunks loaded, so the
  game keeps spawning mobs there; with `mobGriefing` on, endermen lift grass/sand out of the surface
  and leave the pits that look like caves in the viewer (247 of them on one plot). `sendCommandFeedback`
  is the other silent killer: vanilla broadcasts every command's output to all OPs, and 4 opped bots
  firing ~40 `/setblock` per second re-broadcast ~160 chat packets/second to each other - which is what
  timed the bots out mid-build. `src/world.js` `pacifyWorld(bot)` turns all of it off (peaceful,
  no spawning/griefing/fire-tick/weather, permanent noon, no command feedback) and `Crew.assembleTeam`
  calls it on the lead bot. Found 2026-07-12.
- **Roles overwrite each other: `/setblock` REPLACES, and the crew builds mason -> carpenter ->
  decorator -> landscaper.** Anything a later role puts on an earlier role's coordinate wins - which is
  how windows and doors are carved, but also how the cottage's roof punched a hole through its own
  chimney, and how the landscaper's island buried the lighthouse's base course. Worse, a *plant* that
  lands on a wall replaces it and then pops off, leaving a real hole. `finalize()` in `src/library/`
  now drops any pop-off block whose coord an earlier role already claimed; generators that overlap on
  purpose (chimney, island) must exclude the other role's footprint explicitly. Also: **gravity blocks
  (gravel/sand) need solid support** - the lighthouse island's gravel sat on water and 39 blocks fell
  through. Found 2026-07-12.
- **Build order is a TIMELINE, not just a z-order - and the site is aired out before anyone starts.**
  A block whose support arrives later, or whose support is briefly water, is deleted by the game. The
  castle's gate doors died this way for two compounding reasons: the bridge deck was landscaper work
  (last), but so is the moat, and the water reached the empty ground layer under the gate ~26s after
  the carpenter hung the doors - a door whose support turns to water breaks instantly. The bridge is
  now MASON work (first role), the landscaper carves clear of it, and the arch carve is bounded to
  `y >= 0` so it stops eating the deck it stands on. Rules of thumb: **anything load-bearing belongs to
  the mason**, doors need support from a role that runs BEFORE them, and doors are two blocks - see
  `door()` in `src/library/`. All four presets verify 0 missing blocks live. Found 2026-07-12.
- **A worker's block list may be REORDERED for the camera, but only within a y layer.**
  `buildRoute()` (`src/worker.js`) sorts each role's blocks y-ascending, then takes a
  nearest-neighbour walk through each layer, because workers hop to stand beside their work every
  8 blocks and generator order made them teleport across the site all build (the castle mason
  travelled 10,215 blocks; now 2,817). The y-ascending key is load-bearing, not cosmetic - it is
  what keeps the timeline above intact (support before supported, a door's lower half before its
  upper, gravel never onto air). The other rule: **never reorder a repeated coord.** A plan that
  writes a coord twice (place a wall, then carve it to air) encodes intent in that order, and
  flipping it fills the window back in. Library plans can't hit this (`finalize()` de-dupes each
  role, last write wins) but raw model output can, so `walkLayer()` hands back any layer with a
  repeat untouched. Added 2026-07-13.
- **The browser view must be bound to a bot that NEVER MOVES, or it renders a lie.**
  prismarine-viewer re-sends (unloads + reloads) chunk columns every time its bot crosses a
  chunk boundary, and it meshes chunk sections asynchronously in a worker. Race those two and
  `worldrenderer.js` threw the finished geometry away - it re-checked `loadedChunks` when the
  job returned - and NOTHING re-queued it, so the section stayed frozen at whatever it last drew.
  (That throw-away path is patched out by `scripts/patch-viewer.js` as of 2026-07-14, but the
  stationary camera remains the design: chunk churn still costs bandwidth and re-mesh work.)
  The view used to be bound to the lead worker, and workers teleport around the site constantly
  (`Worker.buildBlocks`): one cottage build measured **132 unload/reload cycles**, the sections
  holding the roof froze mid-build, and the browser showed a roofless house with the ridge beam
  hanging in mid-air - while the server world had a complete, correct roof and `verifyBuild`
  reported 0 missing. The build was never broken; only the picture of it was. `src/camera.js`
  adds a 5th bot (`Cam`) - spectator, `physicsEnabled = false`, needs no op (the lead `/tp`s it)
  - that the viewer binds to and that only ever moves BETWEEN builds. 132 unloads -> 0.
  Everything goes through `attachViewer()` / `Crew.viewerBot()`; never call `startViewer()` on a
  bot that builds. `npm run test:viewer` asserts both halves (0 mid-build unloads, every placed
  block reached the browser). Found 2026-07-13.
- **How far the browser can see has TWO ceilings, and the lower one wins.** The hard edge where the
  grass stops and the sky begins is not the edge of the world - it is the edge of what got drawn.
  The browser renders the camera bot's copy of the world, so a chunk has to clear both
  `VIEW_DISTANCE` on the server (`scripts/server.js`, 24 chunks / 384 blocks - it was the vanilla
  default of 10, which is smaller than the 337x337 scene platform, so the far half was never sent
  at all) and `VIEWER_DISTANCE` in the browser (`src/viewer.js`, 16 chunks / 256 blocks - enough to
  cover the 3x3 build grid and its decoration ring, and quadratic in meshing cost above that).
  Raising one alone does nothing. Server settings only apply at container CREATE, so a changed
  `VIEW_DISTANCE` needs `npm run server:recreate` (keeps the world) - `server:stop` + `play` replays
  the old env and looks like the change did nothing. Added 2026-07-13.
- **The browser only learns where to point from a bot `move` event - and the camera bot never
  moves.** prismarine-viewer sends the camera position from exactly one place (`bot.on('move')` in
  `lib/mineflayer.js`), and the page ignores everything until that first packet arrives
  (`firstPositionUpdate` in `lib/index.js` is what aims the camera and sets the orbit target). Our
  camera bot exists precisely BECAUSE it never moves, so it only emits `move` when it's teleported
  between builds - and a browser that connects (or reloads) while the crew is idle, which is most of
  the time, never got a position at all: it rendered the world from the origin and showed an empty
  blue frame, with the world streamed to it and nothing wrong with the build. `startViewer()`
  (`src/viewer.js`) therefore re-announces the position once a second (`bot.emit('move')`). This does
  NOT reintroduce chunk churn - `WorldView.updatePosition` only loads/unloads when the bot crosses a
  CHUNK boundary, so an unchanged position is a no-op and the stationary-camera invariant holds.
  Found 2026-07-13 (the recorder timed out waiting for a camera that was never coming).
- **A browser tab can silently miss ENTITY events, leaving builders drawn floating at stale
  mid-hop positions - so `startViewer()` re-announces every entity too.** The socket's entity
  stream is complete and exact at the source (a tap sees every final teleport land, matching
  rcon to the decimal), but each browser connection has its own delivery: a stall or reconnect
  during a build's block-update flood loses whatever was emitted in the gap, and a builder whose
  final formation teleport got lost stays drawn mid-air/mid-fall forever while the server has it
  parked ("why are some builders floating?"). Same class as the camera re-announce above, same
  cure: every 2s, `bot.emit('entityMoved', e)` for every tracked entity - a strand heals within
  2s, and when the browser is already right the event tweens a position onto itself (no visible
  effect). Verified with an end-to-end watch (census of drawn meshes vs rcon truth after a full
  build: exact match, where pre-fix one bot stranded). Found 2026-07-14.
- **The view must be aimed at the SITE, not the plot.** The browser's orbit camera looks at the
  camera bot's position from 20 blocks up and 20 south of it, so wherever that bot stands IS the
  centre of the shot. It used to be parked on the corner of the plot, which framed a mostly empty
  platform with the build tucked away at the edge of frame. `aimCamera()` (`scripts/web.js`) now
  stands it in the middle of the 40x40 cell that is about to be built on, and `runBuild` re-aims it
  before each build (the site moves - the 3x3 grid, or wherever the user clicked). That re-aim
  happens AFTER `levelSite` and BEFORE the first block: between builds is the only safe moment to
  move the camera. Added 2026-07-13.
- **prismarine-viewer's BROWSER bundle never touches `window` - not even for THREE.** Its
  `global.THREE = require('three')` line lives in `lib/index.js` / `lib/headless.js`, which are the
  NODE entry points; the webpack bundle the browser actually runs keeps three.js in module scope and
  exports nothing. Click-to-place shipped hooking `window.THREE` with a setter, so the setter never
  fired, `window.__cam` was never assigned, and "Pick a spot" returned "no hit" on every click - for
  its entire life, with `npm test` green the whole time, because the test handed `pickGround()` a
  camera and a THREE directly and mocked away the only broken part. The real hook is three.js's
  devtools handshake: every `WebGLRenderer` (and `Scene`) it constructs dispatches an `observe`
  CustomEvent, whose `detail` IS the object, at `window.__THREE_DEVTOOLS__` if one exists. `VIEWER_HOOK`
  (`scripts/web.js`) defines one before the bundle loads, catches the renderer, and wraps its
  `render()` - which is handed the live camera every frame. `pickGround()` then does its vector math
  on the camera's own `Vector3` (`cam.position.clone()`), because there is still no THREE to construct
  one from. `npm test` now runs the REAL hook against a fake renderer AND asserts the bundle on disk
  still dispatches to that global. **When a hook depends on a third-party global, the test must assert
  the third party actually sets it** - anything else tests your own mock. Found 2026-07-13.
- **The world outlives the process - and BOTH halves of the panel's site logic have now been
  burned by forgetting it.** "Clear ground" (the read side) was fixed 2026-07-13; the same day,
  the WRITE side did the same thing: `nextOrigin()` picked the next grid cell from
  `sites().length`, a session counter that resets to zero on every panel restart, so a restart
  over a full plot made the next builds `levelSite()` themselves straight through four finished
  presets. `nextOrigin()` now probes each cell's core via the lead bot's world copy and takes
  the first EMPTY one; a full grid refuses to build (the old code wrapped onto cell 0 and
  demolished it); and `runBuild` rejects requests that arrive before boot sets `baseOrigin`
  (they used to crash mid-boot on `undefined.x`). Any NEW code that decides where to place or
  remove blocks must ask the world, not `state`. Found 2026-07-13, four builds lost.
- **The world outlives the process; `state.sceneSites` does not.** The web panel tracks build origins
  in memory, so after a restart a plot covered in yesterday's buildings reports zero sites - and
  "Clear ground", which used to bulldoze `sites()`, greyed itself out and had nothing to do. It now
  clears the ZONE (`buildArea()` - every grid spot and every hand-pickable spot, widened by
  `levelSite()`'s footprint), and the button is gated on whether the PLOT exists (`clearable`), not on
  what this process remembers building. Same rule anywhere else state is derived from session memory:
  the Minecraft world is on disk and is the source of truth. Verified by scanning the plot after a
  clear - 0 blocks standing in the zone, surface 100% ground; the scene's trees/flowers sit outside
  the zone by design and are deliberately left standing. Found 2026-07-13.
- **prismarine-viewer ships with a bug that makes EVERY STAIR BLOCK invisible in the browser -
  and this project patches it at install AND at startup.** `getModelVariants` (viewer/lib/models.js
  and the prebuilt `public/worker.js` bundle the browser actually executes) skips any block whose
  name CONTAINS "air" - intended for air/cave_air/void_air, but "stAIRs" matches, so all 53 stair
  blocks mesh to zero geometry. Symptom: a building with a stair roof renders as a roofless shell
  with its slab ridge floating in mid-air (slabs render; stairs don't), tower cones render as
  floating apex caps - while the world is perfectly correct and `verifyBuild` reports 0 missing.
  `npm run test:viewer` cannot see it either: it verifies the socket DATA stream, not the pixels.
  `scripts/patch-viewer.js` fixes the installed package (idempotent; `postinstall` + self-heal in
  `startViewer()`), and `npm test` fails if the package is ever unpatched. If a build ever looks
  hollow/roofless in the browser but `verifyBuild` says 0 missing, check this FIRST - it is cheaper
  than the chunk-freeze theory and was the second, longer-lived cause of the same "roofless house"
  symptom the camera bot fixed. Found 2026-07-13 by meshing one stair through the viewer's own
  mesher (planks: 24 vertices, stairs: 0).
- **prismarine-viewer also DELETES a chunk's meshes the instant it slides out of the camera's
  radius - which made the plot's perimeter blink at every build start - and this project patches
  that too.** Every build start hops the camera bot one grid cell (`aimCamera`); the hop slides
  the 16-chunk render radius, and one measured hop fired 17 `unloadChunk`s (tap the viewer's
  socket to see them): a whole strip of shore/water/horizon vanished on the spot while the
  leading edge streamed in over the next seconds. The same unload path is what made the
  frozen-section bug possible (remove the old mesh -> notice the column unloaded -> return,
  stranding a hole). `scripts/patch-viewer.js` now (a) keeps stale meshes when a column leaves
  the radius - the world outside the active build site is static, so the last picture IS the
  correct picture, and it is replaced the moment the column re-enters range - and (b) always
  applies late-arriving geometry. Memory stays bounded (finite scene plots, revisited chunks).
  Same patch mechanics as the stairs fix: idempotent, `postinstall` + `startViewer()` self-heal,
  `npm test` fails if unpatched. Found 2026-07-14 (user report: "blocks flicker in and out
  during builds - the perimeter").
- **The crew builds in PARALLEL (role i starts at i*3000ms, ~10 blocks/s), so "a later role
  overwrites an earlier role's block" is a RACE, not a technique - and the earlier role usually
  wins.** The decorator reaches "its" wall coordinate at t≈6s while the mason lays that wall layer
  at t≈60s, so any window/lamp written OVER a wall block gets stoned back over - and `verifyBuild`
  (which only checks for air) reports 0 missing. Openings must be PUNCHED out of the earlier role's
  list (`canvas.punch()` in `src/library/`) so exactly one role owns every coordinate. The same
  schedule governs attachables: a torch/lantern /setblock onto air survives until a NEIGHBOR update
  hits it while its support is still missing - safe only if the only neighbor event it ever gets is
  its own support arriving. `test/preset-audit.test.mjs` (`npm run test:presets`, also part of
  `npm test`) simulates the real schedule with vanilla physics (neighbor-update pops, gravity, soil
  rules, door support, blocked entrances) across seeded runs of every preset; on 2026-07-13 it found
  ~145 distinct silent defects, including a lighthouse door that popped on 100% of runs and preset
  windows that had never once survived a live parallel build. Run it after ANY change to
  `src/library/` or to the crew's scheduling/stagger.
- `npm run e2e` (single bot) and `npm run replay` (full crew from cached plan) both verify the whole
  path - server, ops, viewer, block placement - against a live server with NO API key. Run one after
  changing bot connection, block placement, or the viewer.
- `npm test` (`test/pick-ground.test.mjs`) covers click-to-place, the one feature that depends on
  prismarine-viewer's internals. It needs no browser and no server: it rebuilds the viewer's camera
  in three.js and runs the real `pickGround()` lifted out of the page source in `scripts/web.js`, so
  it can't drift from the shipped code. It also runs the real hook (now `src/viewer-hook.js` - TWO
  things inject it: the panel's proxy for click-to-place, and `src/shot.js` for the critic's
  screenshots) against a fake renderer, asserts the panel still injects it, and checks it against
  the bundle in `node_modules` - the half that used to be missing (see the invariant above). Two more invariants it pins (each killed the feature silently, found 2026-07-13):
  the page's click-vs-drag guard must arm on `pointerdown`, never `mousedown` - the viewer's orbit
  controls cancel their pointerdown, and a canceled pointerdown suppresses the compatibility
  `mousedown` entirely while `click` still fires, so a mousedown-armed guard reads every click as a
  drag from (0,0) and eats it. And `VIEWER_HOOK` must only park `__cam` from the TO-SCREEN render
  pass (`getRenderTarget() === null`): the viewer draws its sky through the same `render()` as a
  CubeCamera pass whose 6 face cameras sit at the origin, and parking one of those makes picks
  unproject through an identity camera and miss at random. Run it after touching the viewer proxy
  or the page.

---

## The browser viewer and the panel boot

`src/viewer.js` starts a `prismarine-viewer` web view (default `http://localhost:3000`) so anyone
can watch a build in a browser without a Minecraft client - the headline feature for open-source
appeal. It's opt-out via `VIEWER=off` / `--no-viewer` and port-configurable via `VIEWER_PORT`.
`startViewer(bot)` is called on the single bot in `demo.js`/`index.js` and on the first worker only
in `crew.js` (one shared view; all bots share the world). `scripts/web.js` starts it with
`{ prefix: '/viewer', quiet: true }` and reverse-proxies it (HTTP + the socket.io websocket upgrade)
so the whole web UI - prompt box, log, 3D view - is ONE url (`:8080`); the prefix works because the
viewer client derives its socket.io path from `location.pathname`. It never throws: the `prismarine-viewer`
import is dynamic and try/caught, so a missing/broken native `canvas` module degrades to
"watch in-game" instead of crashing the build. `canvas` is an `optionalDependency` for exactly
this reason - `npm install` must never hard-fail on it. Setup + fallback docs: `docs/SETUP.md`.

**`scripts/web.js` listens and opens the browser BEFORE it boots anything.** Startup (server ->
crew -> viewer) takes ~30-60s, and doing it first meant all of that progress existed only in the
terminal - the auto-opened browser landed on an already-finished panel. `main()` now calls
`server.listen()` + `openBrowser()` up front, then runs the boot as three broadcast steps, and the
page opens on a loading screen that renders them live with the SSE log tailed underneath. Two
constraints hold this together: boot state travels inside `publicState()` (not a separate event) so
a late connect or a mid-boot reload resolves correctly from a plain `GET /status`, and the viewer
iframe must NOT be given a `src` until boot completes - `VIEWER_PORT` isn't chosen until then, so an
eager load just pins the iframe to the proxy's 502 page. Anything added to the boot path belongs in
the `boot.steps` list, or it goes back to being invisible outside the terminal.

**The 3D pane keeps its own preloader AFTER boot - dismissed on real mesh progress, never on the
iframe's `load` event.** `load` fires when the viewer's HTML arrives, which is 10-40s before the
world has streamed and meshed; hiding the cover there left a black pane that read as frozen (user
report, 2026-07-30). The overlay (`.vload` + `showVload()`/`pollVload()` in the page) instead
watches actual readiness through the same-origin iframe: the injected hook (`src/viewer-hook.js`)
collects the viewer's three.js scenes on `window.__scenes` (pinned by `npm test`), the parent polls
the biggest scene's child count - one child per meshed chunk section, the sky's cube-map scene
stays tiny so max() skips it - and dismisses when meshing settles (>=24 sections, 2.5s no growth),
with a timeout so the viewer-unavailable fallback page is never trapped behind it. Progress stages
are honest: HTML loaded -> `__cam` parked (first to-screen render) -> section count asymptote. The
same overlay covers scene-travel reloads (`reframeViewer`).

## The two self-correction loops

After the last block lands, `Crew.finishBuild()` runs two passes that answer two different
questions. They are ordered, and the order is load-bearing: a build with holes in it photographs
badly, so a critic shown a half-finished structure spends its whole patch fixing damage the free
pass would have fixed. **Fix what's broken, THEN ask whether it's any good.**
- **REPAIR (`src/repair.js`, free, always on) - "did the world accept it?"** `verifyBuild` already
  found the blocks that never landed and did nothing but print the count. Now they are re-placed
  (y-ascending, by their owning role). **If a round fixes zero blocks, STOP** - those blocks are not
  dropped commands, they are physically illegal (a torch on air, a door with no floor, gravel over
  water), and a third identical `/setblock` is refused identically. Escalate instead: with a live
  provider, the model is shown each failure *with the reason the game refused it* (what is at the
  coord now, what is under it) and returns a patch. Borrowed from Voyager.
- **REVIEW (`src/critic.js`, costs a vision call, opt-in via `CRITIC=on` or the panel's checkbox) -
  "is it any good?"** The game has no opinion about a tower with no windows. `src/shot.js` drives a
  headless browser against the live viewer, orbits it for 3 angles, and the model gets the pictures
  **next to `planDigest()`'s ASCII floor maps of its own plan**. Both halves are required: given only
  the plan the model re-reads its own homework and approves it; given only a photo it can describe
  the flaw but cannot say WHERE it is. Borrowed from APT.
- **The critic's shot must be FRAMED on the build, or the model critiques the lawn.** The browser's
  orbit camera looks at the camera bot from 20 up / 20 south, so that bot's position IS the centre
  of the picture - and during a build it stands at the CORNER of the site (`aimCamera`), because at
  that point there is nothing to centre on yet. `Crew.frameBuild()` re-parks it on the plan's
  bounding-box centre before the shot, **in all three axes**. Both halves were found by looking at
  the actual PNGs: parked at the origin, the tower sat in the corner of an acre of grass, half out
  of frame; then parked at ground level, the shot aimed at the tower's FEET and the whole top half
  (32-block build) fell off the top of the frame. This is the one moment it is safe to move the
  camera - the last block has landed and the next build hasn't started. Pinned by `npm run test:loops`.
- **Every patch from a model is untrusted input - and it is exactly as untrusted as an op, so it
  goes through the same three checks `expandOps` makes.** `normalizePatch()` is the only door: it
  converts plan-relative coords to world-absolute (get that backwards and the fix lands on the
  neighbouring plot), **clamps them to the plot in the RELATIVE frame first** (clamping world
  coordinates against plot-relative bounds would land the whole patch on the origin), **validates
  the block name against the real 1.20.1 registry via `normalizeType`** - repairing near-misses
  (`stone_brick` -> `stone_bricks`) and dropping hallucinations, since `/setblock ...
  minecraft:wooden_plank` is discarded by the server without a word and the hole it was meant to
  fix just stays - coerces unknown roles, and **drops any entry with no block type** (that one goes
  out as `minecraft:undefined`). The name check and the clamp were missing here for as long as
  `expandOps` had them; added 2026-07-29. `npm run test:loops` pins all of it.
- A patch is applied to the **PLAN**, not just the world (`applyPatch`), so the next `verifyBuild`
  holds the patched design to account too. The design is what improved, not just the output.

## The model designs in OPS, not in blocks

**The presets were never better because a human designed them - they were better because a human
gave them PRIMITIVES.** A preset says `walls(...)` and gets 400 gap-free blocks; the model was
asked for that same wall as a JSON array with one object per block, ~11 tokens each. A 900-block
build is then ~10k tokens of pure mechanical enumeration and the castle (3,338 blocks) is ~38k -
which no output budget could buy. So the model did what anyone would when told to enumerate
thousands of tedious items: it shortcut, returning **74 blocks with holes in the walls**, and our
own critic scored it **3/10** and was right.
- `src/ops.js` gives the model the SAME primitives, via `src/library/canvas.js` (extracted from
  the library so presets and AI builds are expanded by identical code). An op is one line and
  expands to hundreds of blocks (~28x compression), so the model can finally afford the scale we
  ask for and spends its budget on DESIGN instead of typing. Same prompt, measured: **74 blocks /
  3/10 -> 2,773 blocks / 10/10, 0 missing.**
- **The point is not compression, it is that the old mistakes become IMPOSSIBLE.** A `walls` op is
  gap-free by construction; `door` always places both halves; `cone` orients its own stair
  shingles. Every rule this crew learned the hard way used to be *requested in prose* and
  reproduced by hand hundreds of times without a slip. Now it is enforced once, in code.
- **If a rule needs two ops to AGREE, make it one op.** Glazing was `punch` the wall + place the
  glass, and the model got the two coordinate sets subtly out of step: the live 10/10 build had
  **panes of glass floating in mid-air outside the tower**, which the critic never mentioned. The
  `window` op now carves and glazes in one move, and glazes ONLY coordinates where a wall was
  really removed (`canvas.punch` returns what it removed) - so a window aimed at thin air is a
  no-op instead of a floating cube. `door` was already this shape; `window` is the same lesson.
- **Every op is UNTRUSTED INPUT** - the same job `normalizePatch` does in `repair.js`. `expandOps`
  is the only door: it clamps coords to the plot (or the fix lands on the neighbour's build),
  refuses a runaway op outright (clamping a world-sized `box` still fills the plot solid), caps the
  total, coerces unknown roles, drops unknown ops - and **validates block names against the real
  1.20.1 registry**, repairing near-misses (`stone_brick` -> `stone_bricks`) and dropping the rest.
  A hallucinated name is the quietest failure in the project: `/setblock` discards it without a
  word, leaving holes nothing in the log explains. A model that ignores the format and returns raw
  BLOCKS is converted to `put` ops and goes through the same door.
- **The op reference in the coordinator's prompt is GENERATED from the `OPS` table**, so the prompt
  cannot describe an op that does not exist or miss one that does.
- **The worked example (`src/plans/reference-ops.json`) is the most-copied build in the project** -
  it is shown to the model on EVERY request, so if it degrades, every AI build degrades with it. It
  is therefore audited on the same parallel-physics simulator as the thirteen presets
  (`npm run test:presets`), and writing it flushed out two real bugs the audit caught before any
  model ever saw it: flowers scattered onto ground that `executeBuild` had cleared to air, and a
  door hung before the mason's foundation reached it. Pinned by `npm run test:ops`.
