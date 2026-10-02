#!/usr/bin/env node
// `npm run web` - a browser control panel for the crew.
//
// Unlike `npm run play` (a one-shot CLI build), this starts a PERSISTENT crew: the
// four bots connect once and stay connected, and a web page lets you submit prompt
// after prompt and watch each build appear - the viewer embedded right on the page.
//
//   npm run web         # open http://localhost:8080
//
// No key -> preset buttons (castle/tower/cottage/lighthouse) build from the free
// library. With a key -> type any prompt and the AI designs it. Each build lands on
// a fresh patch of ground so you end up with a little gallery.
import 'dotenv/config';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureServerUp } from './server.js';
import { Crew } from '../src/crew.js';
import { startViewer } from '../src/viewer.js';
import { VIEWER_HOOK_TAG } from '../src/viewer-hook.js';
import { detectProvider, isLiveProvider, providerLabel, supportsVision } from '../src/providers.js';
import { listBuilds } from '../src/library/index.js';
import { fillRegion as fill, fillPlan } from '../src/fill.js';
import { Vec3 } from 'vec3';
import { isAllowedRequest, isJsonContentType } from '../src/http-guard.js';

const WEB_PORT = parseInt(process.env.WEB_PORT || '8080', 10);
// Loopback only by default - the panel spends your model key. BIND=0.0.0.0 to open it to the LAN.
const WEB_BIND = process.env.BIND || '127.0.0.1';
// The viewer's port is internal - the page only ever talks to WEB_PORT and we
// reverse-proxy /viewer/ to this. It's a `let` because if the preferred port is
// taken (a stale process, a second panel), we roll to the next free one rather
// than silently disabling the viewer for the whole session.
let VIEWER_PORT = parseInt(process.env.VIEWER_PORT || '3000', 10);

// First free port at/after `from`, so a busy 3000 can never kill the browser view.
async function findFreePort(from) {
  for (let p = from; p < from + 20; p++) {
    const free = await new Promise((resolve) => {
      const t = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => t.close(() => resolve(true)))
        .listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return from;
}

// Pop the control panel in the default browser once the server is up. Opt out
// with --no-open or NO_OPEN=1 (e.g. on headless boxes). Tries each opener in
// order and gives up silently - the printed URL always works as a fallback.
function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.argv.includes('--no-open')) return;
  const isWSL = process.platform === 'linux' && /microsoft/i.test(os.release());
  const openers =
    process.platform === 'darwin' ? ['open'] :
    process.platform === 'win32' ? ['start ""'] :
    isWSL ? ['wslview', 'explorer.exe', 'xdg-open'] :   // WSL: hand off to the Windows default browser
    ['xdg-open', 'sensible-browser'];
  const tryNext = (i) => {
    if (i >= openers.length) return;
    exec(`${openers[i]} "${url}"`, (err) => {
      // explorer.exe opens the browser but still exits non-zero - don't cascade
      // after it, or we'd open a duplicate tab. (127 = command not found: DO cascade.)
      if (err && openers[i] === 'explorer.exe' && err.code !== 127) return;
      if (err) tryNext(i + 1);
    });
  };
  tryNext(0);
}

// --- live log fan-out (Server-Sent Events) -------------------------------------
const clients = new Set();          // open SSE responses
const logBuffer = [];               // recent lines, replayed to new clients
const MAX_BUFFER = 300;

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { /* dropped */ } }
}
function pushLog(text) {
  for (const raw of String(text).split('\n')) {
    const s = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();   // strip ANSI colour
    if (!s.trim()) continue;
    logBuffer.push(s);
    if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
    broadcast({ type: 'log', line: s });
  }
}
// Tee console output to the web log while keeping the terminal output intact.
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try { pushLog(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); } catch { /* noop */ }
  };
}

// --- scenes ----------------------------------------------------------------------
// A "scene" is a CONSTRUCTED pretty starting point, not a trip into the messy real
// world. Each is built in place at the home spawn as a clean, flat, self-contained
// platform: a solid encasing base (so no caves/ravines poke through underneath), a
// themed surface, and tasteful backdrop decoration around the edges - leaving the
// centre flat and clear to build on. `ground` = the surface block (also used to
// level individual build sites); `support` = the non-gravity block that encases the
// base; `biome` = set with /fillbiome over the whole plot - REQUIRED, because grass
// colour, foliage colour, sky and water are all biome TINTS, not block properties:
// grass_block in a desert renders dry olive, and a biome seam mid-platform shows up
// as a patch of a different green. `decorate` = optional edge dressing. `shore` = taper the
// platform's outer band down into water instead of ending it in a cliff (see buildShore).
// `waterBiome` = a second biome painted over the shore water only: water colour is a biome
// tint too, so this is what turns a flat blue moat into a turquoise tropical sea.
const SCENES = {
  spawn:     { label: 'Plains',      ground: 'grass_block', support: 'stone',     biome: 'plains',        decorate: decoPlains },
  beach:     { label: 'Beach',       ground: 'sand',        support: 'sandstone', biome: 'beach',         decorate: decoBeach, shore: true, waterBiome: 'warm_ocean' },
  desert:    { label: 'Desert',      ground: 'sand',        support: 'sandstone', biome: 'desert',        decorate: decoDesert },
  mountains: { label: 'Mountains',   ground: 'grass_block', support: 'stone',     biome: 'meadow',        decorate: decoMountains },
  snowy:     { label: 'Snowy',       ground: 'snow_block',  support: 'stone',     biome: 'snowy_plains',  decorate: decoSnowy },
  jungle:    { label: 'Jungle',      ground: 'grass_block', support: 'stone',     biome: 'jungle',        decorate: decoJungle },
  cherry:    { label: 'Cherry Grove', ground: 'grass_block', support: 'stone',    biome: 'cherry_grove',  decorate: decoCherry },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every scene's walkable surface sits at this fixed height. Building at a constant
// Y (rather than wherever the crew happens to stand) keeps scenes predictable and
// above sea level, so water never seeps in and the platform reads as a clean raised
// clearing regardless of the natural terrain it replaces.
const STAGE_Y = 72;

// Vanilla sea level: the topmost water block in an ocean is y=62 (y=63 is the first air).
// A `shore` scene's apron is cut to exactly this level, so a plot that happens to land in a
// real ocean merges with it seamlessly instead of leaving a one-block seam of flowing water.
const SEA_Y = 62;
// The shoreline. Without it a scene is a solid rectangular prism - a table of sand ending in
// a 9-block cliff over the sea, which is what gives away that it's a constructed platform.
// A `shore` scene instead steps its outer band down 1 block every SHORE_RUN blocks until it
// is SHORE_DEPTH under the waterline, and floods everything below. 13 steps x 3 = a 39-block
// apron: wide enough to read as a gradual beach, narrow enough that the platform's flat
// interior - and the whole 3x3 build grid - is untouched.
const SHORE_RUN = 3;
const SHORE_DEPTH = 4;
const SHORE_STEPS = (STAGE_Y - 1) - (SEA_Y - SHORE_DEPTH);   // 71 -> 58
const SHORE_W = SHORE_STEPS * SHORE_RUN;

// A distinctive block buried well under each finished plot (below the support slab, so it
// is never visible), stamped with the layout that produced it. Changing this string forces
// every cached scene to rebuild - the block-signature probe alone can't tell "built by the
// current layout" from "built by an older, smaller one", so bump it whenever the geometry,
// biome pass or decoration changes materially.
const SCENE_STAMP = 'note_block';   // v6: + spaced cacti, peaks clamped to the platform

// The "build here" marker: a one-block-wide outline of the next build's footprint, laid
// flush into the surface so it reads from any angle in the viewer. It sits exactly on the
// footprint levelSite() clears, so starting the build erases it for free.
const MARKER_BLOCK = 'sea_lantern';

// --- build state ----------------------------------------------------------------
const state = {
  provider: detectProvider(),
  live: isLiveProvider(),
  providerLabel: providerLabel(),
  canReview: isLiveProvider() && supportsVision(),
  busy: false,
  // repairing: re-placing blocks the world refused (always runs when something is missing).
  // reviewing: showing photographs of the build to a vision model (opt-in, costs a call).
  phase: 'idle',            // idle | planning | building | repairing | reviewing | clearing | traveling | done | error
  last: null,               // { name, blocks, prompt, missing, repaired }
  review: null,             // the critic's verdict on the last build: { score, verdict, issues }
  background: 'spawn',
  builtScenes: new Set(),   // scenes constructed this session (or detected pre-built)
  // Where every build on each plot actually went. Tracked as real origins, not a count:
  // once a build can be hand-placed anywhere, "site N of the grid" no longer describes it,
  // and "Clear ground" has to bulldoze the spots the crew REALLY used.
  sceneSites: {},           // scene id -> [{x,y,z}]
  placement: null,          // the hand-picked origin for the next build (null = next grid spot)
  marker: null,             // { o, ground } - the outline currently drawn on the ground
  sceneNonce: 0,            // bumped whenever a scene is (re)built, so the viewer re-frames
                            // even when the scene NAME didn't change (a rebuild in place)
};
// Every build origin on the CURRENT plot, in the order they were built.
function sites() {
  return (state.sceneSites[state.background] ||= []);
}
function setPhase(phase, extra = {}) {
  state.phase = phase;
  Object.assign(state, extra);
  broadcast({ type: 'status', ...publicState() });
}

// --- boot progress ----------------------------------------------------------------
// Startup (server -> crew -> viewer) takes ~30-60s and USED to run entirely before the
// web server listened, so the only place you could watch it was this terminal - the
// browser popped open on an already-finished panel. Now main() listens first and the
// page opens immediately on a boot screen that renders these steps (plus the live log
// stream, which already fans out over SSE) as they complete. `boot` rides along inside
// publicState() rather than in a separate event so a browser that connects late, or
// reloads mid-boot, resolves to the right screen from a plain GET /status.
const boot = {
  done: false,
  error: null,
  steps: [
    { id: 'server', label: 'Waking the Minecraft server', state: 'pending' },
    { id: 'crew', label: 'Assembling the build crew', state: 'pending' },
    { id: 'viewer', label: 'Starting the live 3D view', state: 'pending' },
  ],
};
let viewerReady = false;   // the page holds the iframe's src until this is true (see PAGE)
function setBoot(id, st) {
  const step = boot.steps.find((s) => s.id === id);
  if (step) step.state = st;
  broadcast({ type: 'status', ...publicState() });
}
function bootFailed(message) {
  boot.error = message;
  for (const s of boot.steps) if (s.state === 'active') s.state = 'failed';
  broadcast({ type: 'status', ...publicState() });
}

function publicState() {
  return {
    provider: state.provider, live: state.live, providerLabel: state.providerLabel,
    busy: state.busy, phase: state.phase, last: state.last, built: sites().length,
    // The visual critic needs a model that can see (src/critic.js). Presets always build from
    // the library, so the toggle is only offered on prompt builds with a vision provider.
    canReview: state.canReview, review: state.review,
    // Whether "Clear ground" has anything to do. NOT `built > 0`: that only counts builds made
    // in THIS process, and the plot's builds outlive it (the world is on disk, sceneSites isn't),
    // so a plot full of yesterday's houses reported 0 and greyed the button out for good.
    // Once the plot exists, it can be cleared - on an empty one that just re-levels bare ground.
    clearable: state.builtScenes.has(state.background),
    background: state.background, sceneNonce: state.sceneNonce,
    placement: state.placement && { x: state.placement.x, z: state.placement.z },
    surfaceY: STAGE_Y,   // the y the page raycasts a click against (top face of the ground)
    boot,                // { done, error, steps[] } - drives the loading screen
  };
}

let crew, baseOrigin, SPAWN;

// Park each bot on its own spot along the front edge of the site - all four on
// one block renders as a single bot in the viewer. Teleports fire in parallel.
async function formation(o) {
  await Promise.all(crew.activeWorkers.map((w, i) => w.teleportTo(o.x - 2 + i * 8, o.y, o.z - 6)));
}

// Point the camera at the 40x40 cell starting at `o` - the site a build is about to go up on.
//
// The browser's orbit camera anchors on the camera bot: it looks AT that bot's position from 20
// blocks above and 20 south of it (prismarine-viewer's lib/index.js sets exactly that offset on
// the first position it receives). So wherever this bot stands is the centre of the shot, and
// parking it on the corner of the PLOT - which is what this used to do - framed a mostly empty
// platform with the build tucked away at the edge. Standing it in the middle of the cell instead
// puts the build in the middle of the picture, and the eye ends up in open air over the site's
// south edge rather than inside whatever gets built.
//
// Only ever called BETWEEN builds (scene switch, and just before a build starts). Moving the
// camera is the one thing that makes the viewer drop geometry, so it must never happen while
// the crew is placing blocks - see src/camera.js.
async function aimCamera(o) {
  if (!crew?.camera?.alive) return;
  await crew.camera.park(lead(), { x: o.x + 16, y: o.y + 2, z: o.z + 16 });
}

// Where the NEXT build goes: the spot the user staked out, or - if they haven't picked
// one - the next free cell of a tidy 3x3 grid, so successive builds don't overlap.
//
// "Free" is judged by the WORLD, not by this process's memory. It used to be a session
// counter (`sites().length`), and the world outlives the process: restart the panel over a
// plot with builds on it and the counter said zero, so the next builds levelSite()'d
// themselves straight through whatever was standing on the first cells - four verified
// presets bulldozed before anyone noticed (2026-07-13). Same lesson as "Clear ground":
// the Minecraft world is on disk and is the source of truth; session state is a cache.
function slotOccupied(bot, o) {
  // sample the cell's core (builds live in 0..31; the levelling margins overlap neighbors)
  for (let dx = 0; dx <= 31; dx += 3)
    for (let dz = 0; dz <= 31; dz += 3)
      for (let dy = 0; dy <= 24; dy += 2)
        if (bot.blockAt(new Vec3(o.x + dx, o.y + dy, o.z + dz))?.name !== 'air') return true;
  return false;
}
function nextOrigin() {
  if (state.placement) return { ...state.placement };
  const bot = crew?.activeWorkers?.[0]?.bot;
  if (!bot) throw new Error('No crew connected - cannot find a free build site.');
  for (let n = 0; n < 9; n++) {
    const o = { x: baseOrigin.x + (n % 3) * 40, y: baseOrigin.y, z: baseOrigin.z + Math.floor(n / 3) * 40 };
    if (!slotOccupied(bot, o)) return o;
  }
  // Every cell has something on it. The old behavior wrapped the rotation and built OVER
  // cell 0 - silently demolishing whatever stood there. Refusing is the only safe answer.
  throw new Error('All 9 grid sites are occupied - use "Clear ground" or "Pick a spot".');
}

async function runBuild({ prompt, preset, review = false }) {
  // A request can arrive in the gap between crew assembly and the scene anchoring
  // (baseOrigin isn't set until then) - building would crash on nextOrigin and, worse,
  // could land on an unanchored origin. Refuse until boot declares itself done.
  if (!boot.done || !baseOrigin) throw new Error('The panel is still booting - try again in a moment.');
  if (state.busy) throw new Error('A build is already running.');
  state.busy = true;
  const label = preset ? `preset:${preset}` : prompt;
  setPhase('planning', { last: null, review: null });
  console.log(`\n[Web] Build request: "${label}"`);

  // Presets always come from the free library, even if an AI key is set. Force it
  // for the duration of this build, then restore the user's provider.
  const savedProvider = process.env.LLM_PROVIDER;
  const savedLibrary = process.env.LIBRARY_BUILD;
  if (preset) { process.env.LLM_PROVIDER = 'library'; process.env.LIBRARY_BUILD = preset; }

  try {
    await ensureCrew();
    for (const w of crew.activeWorkers) w.blocksPlaced = 0;   // per-build count
    const origin = nextOrigin();
    // Remember the site BEFORE building, not after: a build that fails half-way still left
    // debris there, and "Clear ground" has to know about it.
    sites().push(origin);
    // Consume the hand-picked spot - the next build falls back to the grid unless the user
    // picks again. levelSite() re-lays this exact footprint, so it erases the marker for us.
    state.placement = null;
    state.marker = null;
    // Flatten a platform first so the build sits level on any terrain (mountainside,
    // beach dunes...). Teleport the lead there first - /fill needs loaded chunks.
    const lead = crew.activeWorkers[0];
    await lead.teleportTo(origin.x + 16, origin.y, origin.z + 16);
    await levelSite(lead.bot, origin);
    // Look at the site we're about to build on. The site moves (the 3x3 grid, or wherever the
    // user clicked), so a camera parked once per plot ends up watching an empty corner of it.
    // NOW is the only safe moment to move it: the ground is levelled, nothing is being placed.
    await aimCamera(origin);
    setPhase('building');
    // aimCamera: false - the camera is parked (just above), and must NOT move again while
    // the crew is placing blocks (see aimCamera above / src/camera.js).
    //
    // `review` photographs the finished build and shows it to a vision model (src/critic.js).
    // It is per-build rather than a process-wide setting because it costs a model call and the
    // user is standing right there deciding whether this build is worth one.
    const plan = await crew.executeBuild(prompt || 'a surprise build', {
      origin,
      aimCamera: false,
      review: review && state.live,
      // The repair and review passes take tens of seconds each and used to be invisible: the
      // panel said "building", the bots stood still, and the page looked hung. Report them.
      onPhase: (p) => setPhase(p),
    });
    const blocks = crew.activeWorkers.reduce((s, w) => s + w.blocksPlaced, 0);
    // executeBuild re-reads the world and counts what never landed. Say so out loud rather
    // than reporting a block count that only says how many commands we fired.
    const miss = plan.verified?.missing || 0;
    setPhase('done', {
      last: { name: plan.name, blocks, prompt: label, missing: miss, repaired: plan.repair?.before || 0 },
      review: plan.review && { score: plan.review.score, verdict: plan.review.verdict, issues: plan.review.issues },
    });
    console.log(`[Web] Done: "${plan.name}" (${blocks} blocks${miss ? `, ${miss} MISSING` : ', all verified in-world'})`);
  } catch (err) {
    console.error(`[Web] Build failed: ${err.message}`);
    setPhase('error', { last: { name: 'Build failed', blocks: 0, prompt: err.message } });
  } finally {
    if (preset) {
      if (savedProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = savedProvider;
      if (savedLibrary === undefined) delete process.env.LIBRARY_BUILD; else process.env.LIBRARY_BUILD = savedLibrary;
    }
    state.busy = false;
    // Keep the terminal phase ('done' or 'error') so the result stays on screen
    // until the next build starts - just broadcast that we're no longer busy.
    broadcast({ type: 'status', ...publicState() });
  }
}

function groundBlock() {
  return (SCENES[state.background] || {}).ground || 'grass_block';
}

// The scene platform. Sized off the VIEWER's render distance, not the build grid:
// prismarine-viewer draws 6 chunks (~96 blocks) around the bot, so unless the platform
// reaches at least that far in every direction from wherever a bot stands, the natural
// world shows past its edge - which is why Plains looked like a green rug dropped in a
// desert. Bots idle near o..o+22 and roam the grid out to ~o+120, so the platform has to
// cover o-96 .. o+216 at minimum; these bounds clear that with margin.
function sceneBounds(o) {
  return { x0: o.x - 112, x1: o.x + 224, z0: o.z - 112, z1: o.z + 224 };   // 337x337
}
// The build grid + a margin - decoration must stay OUT of this so builds land clear.
function isInBuildArea(o, x, z) {
  return x > o.x - 24 && x < o.x + 136 && z > o.z - 24 && z < o.z + 136;
}
// A hand-picked build origin is clamped to here: the same flat, decoration-free zone the
// auto grid uses, with room for levelSite's 48x48 footprint (origin-8 .. origin+39) to fit
// inside it. Keeping placement in this box also keeps the marker outline away from the
// isSceneBuilt probe points, which live outside the build area on purpose.
function clampPlacement(o, x, z) {
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  return { x: cl(x - 16, o.x - 12, o.x + 93), y: o.y, z: cl(z - 16, o.z - 12, o.z + 93) };
}

// Each scene lives on its OWN permanent plot, laid out in a row from the world
// spawn. Because the Minecraft world is saved to disk, a scene built once stays
// built forever - revisiting it is just a teleport, no rebuild.
function plotAnchor(id) {
  const i = Math.max(0, Object.keys(SCENES).indexOf(id));
  return { x: SPAWN.x + i * 320, y: STAGE_Y, z: SPAWN.z };
}

// Has this plot already been constructed (this session or a previous one)? Signature check
// that natural terrain won't match: the themed ground sits at EXACTLY o.y-1 over the
// encasing support block, out to a corner only the current wide layout reaches, over a
// buried layout stamp.
//
// CRITICAL: every probe point must sit OUTSIDE the build area. Probing the build grid (the
// obvious choice - it's right at the origin) means the user's own castle answers the probe:
// the ground there is no longer bare, so the scene reads as "not built" and gets rebuilt
// from scratch, destroying every build on the plot. Probes also stay clear of the shore
// apron, the snowy pond and anything decoration writes at o.y-1.
//
// Waits for the plot's chunks to stream in first. The points sit in DIFFERENT chunks, and
// an unloaded chunk reads `null` - indistinguishable from "not built" - so judging before
// they all arrive needlessly rebuilds a perfectly good plot.
async function isSceneBuilt(bot, o, sc) {
  const at = (dx, y, dz) => { try { const b = bot.blockAt(new Vec3(o.x + dx, y, o.z + dz)); return b && b.name; } catch { return null; } };
  const points = [[-60, o.y - 1, -60], [-60, o.y - 3, -60], [170, o.y - 1, -60], [0, o.y - 30, 0]];
  for (let i = 0; i < 40; i++) {                       // up to ~10s
    if (points.every(([dx, y, dz]) => at(dx, y, dz) !== null)) break;
    await sleep(250);
  }
  if (points.some(([dx, y, dz]) => at(dx, y, dz) === null)) return false;   // still can't see it - rebuild

  const core = at(-60, o.y - 1, -60) === sc.ground && at(-60, o.y - 3, -60) === sc.support;
  const wide = at(170, o.y - 1, -60) === sc.ground;   // only the current wide platform reaches here
  const stamped = at(0, o.y - 30, 0) === SCENE_STAMP;
  return core && wide && stamped;
}

// The /fill splitter lives in src/fill.js now - the crew's own "clear the area first" had the
// same 32768-block cliff and was silently doing nothing on large builds, so there is one copy
// of the rule and everything that clears ground uses it.

// The tripwire for the silent-no-op failure mode. Every command below leaves as a chat message
// from the lead bot, and mineflayer discards chat from a bot that has disconnected WITHOUT
// throwing - so a lead that drops half way through a scene lets the remaining hundreds of fills
// evaporate, and the scene reports "ready" with half a platform. Checking liveness before each
// command turns that into a loud error, which buildScene retries.
function assertLead() {
  const w = crew && crew.activeWorkers && crew.activeWorkers[0];
  if (!w || !w.alive) throw new Error('the lead bot dropped - its commands would go nowhere');
}

const fillRegion = (bot, x0, y0, z0, x1, y1, z1, block) =>
  fill(bot, x0, y0, z0, x1, y1, z1, block, { assert: assertLead });

// The four strips of a rectangular ring `inset` blocks in from the platform edge and
// `thick` blocks wide. The end strips take the corners, so the strips never overlap.
function frameStrips(b, inset, thick) {
  const x0 = b.x0 + inset, x1 = b.x1 - inset, z0 = b.z0 + inset, z1 = b.z1 - inset;
  return [
    { x0, x1, z0, z1: z0 + thick - 1 },
    { x0, x1, z0: z1 - thick + 1, z1 },
    { x0, x1: x0 + thick - 1, z0: z0 + thick, z1: z1 - thick },
    { x0: x1 - thick + 1, x1, z0: z0 + thick, z1: z1 - thick },
  ];
}

// Cut a shoreline into the platform's outer band: carve the band away, then re-lay it as a
// staircase running from the lagoon floor back up to the surface, flooding every step that
// sits under the waterline. The result reads as a beach sloping into the sea from every side.
//
// Each step is filled SOLID from the lagoon floor up to its own height, not just capped with
// a one-block shelf. A shelf is what the first version laid, and it does not survive contact
// with the world: sand is a GRAVITY block, and the step outside it was carved down to the
// floor, so every shelf was a slab of sand hanging over air. It fell the instant it was
// placed, water poured into the gap, and the beach came out full of holes.
async function buildShore(bot, o, b, sc) {
  const surfaceY = o.y - 1;
  const floorY = SEA_Y - SHORE_DEPTH;
  for (const r of frameStrips(b, 0, SHORE_W))                                // carve the whole apron out
    await fillRegion(bot, r.x0, floorY + 1, r.z0, r.x1, surfaceY, r.z1, 'air');
  for (let step = 0; step < SHORE_STEPS; step++) {                             // outermost (deepest) step first
    const y = floorY + step;
    for (const r of frameStrips(b, step * SHORE_RUN, SHORE_RUN)) {
      await fillRegion(bot, r.x0, floorY, r.z0, r.x1, y, r.z1, sc.ground);     // solid, all the way down
      if (y < SEA_Y) await fillRegion(bot, r.x0, y + 1, r.z0, r.x1, SEA_Y, r.z1, 'water');
    }
  }
}

// Repaint the plot's BIOME (1.19.4+ /fillbiome). This is what actually makes a scene
// look like its theme: grass/foliage colour, sky, fog and water are biome tints, so
// grass_block in a desert renders dry olive no matter what block you place. Also kills
// the patchwork of different greens you get when a biome seam crosses the platform.
// /fillbiome enforces the SAME 32768-block cap as /fill, so it has to be split on volume
// too. Tiling it naively at 32x32 over the platform's full height was 32*32*66 = 67k per
// command: the server rejected 4 out of every 5 of them and only the thin edge strips
// landed, which looks exactly like "the biome pass ran" while the middle stayed desert.
async function fillBiome(bot, x0, y0, z0, x1, y1, z1, biome) {
  for (const [ax, ay, az, bx, by, bz] of fillPlan(x0, y0, z0, x1, y1, z1)) {
    assertLead();
    bot.chat(`/fillbiome ${ax} ${ay} ${az} ${bx} ${by} ${bz} minecraft:${biome}`);
    await sleep(45);
  }
}

// /fillbiome updates the biome on the SERVER but does not re-send the chunks to clients
// that already have them. The crew bots connected long before the scene was painted, so
// their world - and the viewer, which renders from the bot's world, not from the server -
// keeps the OLD biome. That's why a plains platform still rendered desert-olive: right
// blocks, stale tint. Teleporting the crew clear of the server's view distance and back
// forces those chunks to unload and be re-sent, biome and all.
async function refreshChunks(o) {
  const biomeAt = () => { try { return lead().blockAt(new Vec3(o.x + 20, o.y - 1, o.z + 20))?.biome?.id; } catch { return null; } };
  const before = biomeAt();
  // The CAMERA has to make this trip too, not just the crew: the browser renders from the
  // camera's copy of the world, so refreshing everyone else's and leaving the camera behind
  // would fix the bots' biome and change nothing about the picture.
  await Promise.all(crew.activeWorkers.map((w) => w.teleportTo(o.x, o.y + 60, o.z - 700)));
  if (crew.camera?.alive) await crew.camera.park(lead(), { x: o.x, y: o.y + 60, z: o.z - 700 });
  await sleep(2500);
  await formation(o);
  await aimCamera(o);
  await sleep(2500);
  console.log(`[Web] Chunks refreshed - bot-side biome ${before} -> ${biomeAt()}`);
}
function lead() { return crew.activeWorkers[0].bot; }

// Every /fill, /setblock and /tp in this file goes out as a CHAT COMMAND from the lead bot,
// and `bot.chat()` on a disconnected bot is a silent no-op - it doesn't throw, it just does
// nothing. So a lead that dropped (a duplicate login, a timeout) makes a scene "build" with
// no blocks placed and a marker that never appears, with a clean log and no error anywhere.
// crew.ensureAlive() reconnects anyone who fell off; call it before issuing ANY command.
// (crew.executeBuild does this itself, so only the paths that bypass it need it.)
async function ensureCrew() {
  await crew.ensureAlive();
}

// --- scene decoration -------------------------------------------------------------
// Decoration rings the platform, everywhere OUTSIDE the build area, so the 3x3 build
// grid in the near corner (o .. o+119) stays flat and clear.
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.round(rnd(a, b));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function put(bot, x, y, z, block) { assertLead(); bot.chat(`/setblock ${x} ${y} ${z} minecraft:${block}`); }

// Random spots anywhere on the platform EXCEPT the build area - decoration rings the
// whole scene (so it reads as a real landscape, not a strip along one edge) while the
// build grid stays flat and clear. `margin` keeps a decoration's FOOTPRINT on the
// platform (a 10-wide mountain picked 6 from the edge juts 4 blocks into thin air);
// `avoid` rejects spots a scene has already claimed for something else, like a pond.
function backdropSpots(o, b, n, { margin = 6, avoid } = {}) {
  const spots = [];
  for (let i = 0; i < n * 40 && spots.length < n; i++) {
    const x = ri(b.x0 + margin, b.x1 - margin), z = ri(b.z0 + margin, b.z1 - margin);
    if (isInBuildArea(o, x, z)) continue;
    if (avoid && avoid(x, z)) continue;
    spots.push([x, z]);
  }
  return spots;
}

async function placeTree(bot, x, y, z, log, leaf, h = 5) {
  for (let i = 0; i < h; i++) put(bot, x, y + i, z, log);
  for (let dy = h - 2; dy <= h + 1; dy++)
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) + Math.max(0, dy - h) > 3) continue;   // rounded canopy
        if (dx === 0 && dz === 0 && dy < h) continue;                          // don't bury the trunk
        put(bot, x + dx, y + dy, z + dz, leaf);
      }
  await sleep(40);
}

async function scatterTrees(bot, o, b, log, leaf, n = 9, opts = {}) {
  for (const [x, z] of backdropSpots(o, b, n, opts)) await placeTree(bot, x, o.y, z, log, leaf, ri(4, 6));
}

async function decoPlains(bot, o, b) {
  await scatterTrees(bot, o, b, 'oak_log', 'oak_leaves', 16);
  for (const [x, z] of backdropSpots(o, b, 90)) put(bot, x, o.y, z, pick(['poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'grass', 'grass', 'grass']));
  await sleep(40);
}
async function decoJungle(bot, o, b) {
  await scatterTrees(bot, o, b, 'jungle_log', 'jungle_leaves', 24);
}
async function decoCherry(bot, o, b) {
  await scatterTrees(bot, o, b, 'cherry_log', 'cherry_leaves', 22);
  for (const [x, z] of backdropSpots(o, b, 70)) put(bot, x, o.y, z, 'pink_petals');
  await sleep(40);
}
async function decoDesert(bot, o, b) {
  // A cactus breaks itself if ANY horizontally-adjacent block is solid - including another
  // cactus. Random spots on a big platform rarely collide, but "rarely" means the desert
  // quietly loses a cactus now and then, so keep them a clear block apart by construction.
  const planted = [];
  const clashes = (x, z) => planted.some(([px, pz]) => Math.abs(px - x) <= 2 && Math.abs(pz - z) <= 2);
  for (const [x, z] of backdropSpots(o, b, 30, { avoid: clashes })) {
    planted.push([x, z]);
    const h = ri(2, 4);
    for (let k = 0; k < h; k++) put(bot, x, o.y + k, z, 'cactus');
  }
  // Dead bushes are not solid, so they can sit next to a cactus - they just can't sit ON one.
  for (const [x, z] of backdropSpots(o, b, 40, { avoid: (x, z) => planted.some(([px, pz]) => px === x && pz === z) }))
    put(bot, x, o.y, z, 'dead_bush');
  await sleep(40);
}
// A frozen pond out past the build area, flush with the surface. Cut as a rough circle,
// row by row: the old version filled a rectangle spanning the platform's whole width,
// which reads as a giant white slab, not a pond.
const POND = { dx: 170, dz: 170, r: 34 };
function inPond(o, x, z) {
  const dx = x - (o.x + POND.dx), dz = z - (o.z + POND.dz);
  return dx * dx + dz * dz < (POND.r + 5) * (POND.r + 5);   // +5 so trees don't stand on the rim
}
async function decoSnowy(bot, o, b) {
  const cx = o.x + POND.dx, cz = o.z + POND.dz;
  for (let dz = -POND.r; dz <= POND.r; dz++) {
    const w = Math.round(Math.sqrt(POND.r * POND.r - dz * dz)) + ri(-2, 2);   // wobbly edge, not a stamped circle
    if (w < 1) continue;
    await fillRegion(bot, cx - w, o.y - 1, cz + dz, cx + w, o.y - 1, cz + dz, 'packed_ice');
  }
  await scatterTrees(bot, o, b, 'spruce_log', 'spruce_leaves', 16, { avoid: (x, z) => inPond(o, x, z) });
}
async function decoMountains(bot, o, b) {
  // Stone peaks with snow caps ringing the scene - a backdrop skyline. The margin has to clear
  // the widest peak's radius, or a peak picked near the edge spills off the platform and hangs
  // in mid-air over the natural terrain below. Each layer is also clamped to the platform, so
  // no future change to the radius can reintroduce that.
  const cx = (v) => Math.max(b.x0, Math.min(b.x1, v));
  const cz = (v) => Math.max(b.z0, Math.min(b.z1, v));
  for (const [x, z] of backdropSpots(o, b, 9, { margin: 12 })) {
    const R = ri(6, 10), H = ri(10, 20);
    for (let y = 0; y < H; y++) {
      const r = Math.max(1, Math.round(R * (1 - y / H)));
      await fillRegion(bot, cx(x - r), o.y + y, cz(z - r), cx(x + r), o.y + y, cz(z + r), y > H - 3 ? 'snow_block' : 'stone');
    }
  }
}
// A palm: bare trunk, small crown, fronds drooping a block below it.
async function placePalm(bot, x, y, z) {
  const h = ri(5, 7), top = y + h;
  for (let i = 0; i < h; i++) put(bot, x, y + i, z, 'jungle_log');
  put(bot, x, top, z, 'jungle_leaves');
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    put(bot, x + dx, top, z + dz, 'jungle_leaves');
    put(bot, x + dx * 2, top - 1, z + dz * 2, 'jungle_leaves');
  }
  await sleep(40);
}
async function decoBeach(bot, o, b) {
  // The shore apron IS the sea now, so the beach needs no pool - dress the dry sand behind
  // the waterline instead (decoration inside the apron would be standing in the water).
  const dry = { x0: b.x0 + SHORE_W, x1: b.x1 - SHORE_W, z0: b.z0 + SHORE_W, z1: b.z1 - SHORE_W };
  for (const [x, z] of backdropSpots(o, dry, 7)) await placePalm(bot, x, o.y, z);
  for (const [x, z] of backdropSpots(o, dry, 12)) put(bot, x, o.y, z, 'dead_bush');
  await sleep(40);
}

// Level one build site into a flat platform: air out the footprint, then lay a
// solid 4-deep base of the background's ground block (covers moats, dug-up lawns,
// and gentle slopes - so builds sit flat on ANY terrain). The lead bot must be
// teleported to the site first: /fill only works in loaded chunks.
async function levelSite(bot, o) {
  // builds extend ~8 blocks past their origin on the low side (castle moat/lawn)
  const [x0, x1, z0, z1] = [o.x - 8, o.x + 39, o.z - 8, o.z + 39];
  // fillRegion splits this on volume for us - the 48x48x60 footprint is 138,240 blocks, well
  // over the 32,768 a single /fill accepts before it is refused without a word.
  await fillRegion(bot, x0, o.y, z0, x1, o.y + 59, z1, 'air');
  await fillRegion(bot, x0, o.y - 4, z0, x1, o.y - 1, z1, groundBlock());
}

// --- "build it HERE" marker -------------------------------------------------------
// The outline of the next build's footprint, laid flush INTO the surface (at o.y-1, the
// ground layer) rather than on top of it, so it doesn't trip up the builders and reads
// cleanly from the viewer's overhead angle.
async function ringFill(bot, o, block) {
  const y = o.y - 1;
  const [x0, x1, z0, z1] = [o.x - 8, o.x + 39, o.z - 8, o.z + 39];   // exactly levelSite's footprint
  await fillRegion(bot, x0, y, z0, x1, y, z0, block);
  await fillRegion(bot, x0, y, z1, x1, y, z1, block);
  await fillRegion(bot, x0, y, z0 + 1, x0, y, z1 - 1, block);
  await fillRegion(bot, x1, y, z0 + 1, x1, y, z1 - 1, block);
}
// Put the ground back exactly as it was. The marker's own ground block is remembered from
// when it was drawn - the scene (and so groundBlock()) may have changed since.
async function eraseMarker() {
  if (!state.marker) return;
  await ringFill(lead(), state.marker.o, state.marker.ground);
  state.marker = null;
}
// Stake out where the crew should build next. `cx`/`cz` is the point the user clicked in
// the 3D view; the build is centred on it, clamped to the flat build area.
async function placeAt(cx, cz) {
  if (state.busy) throw new Error('A build is already running.');
  state.busy = true;
  try {
    await ensureCrew();
    const o = clampPlacement(baseOrigin, cx, cz);
    await eraseMarker();
    await ringFill(lead(), o, MARKER_BLOCK);
    state.marker = { o, ground: groundBlock() };
    state.placement = o;
    console.log(`[Web] Next build staked out at (${o.x}, ${o.z}).`);
  } catch (err) {
    console.error(`[Web] Could not stake that spot: ${err.message}`);
  } finally {
    state.busy = false;
    broadcast({ type: 'status', ...publicState() });
  }
}
// Back to the automatic 3x3 gallery grid.
async function clearPlacement() {
  if (state.busy) throw new Error('A build is already running.');
  state.busy = true;
  try {
    await ensureCrew();
    await eraseMarker();
    state.placement = null;
    console.log('[Web] Placement cleared - the next build goes to the next free grid spot.');
  } finally {
    state.busy = false;
    broadcast({ type: 'status', ...publicState() });
  }
}

// The whole zone a build can ever land in: every auto-grid spot (origin .. origin+80 on each
// axis) and every hand-picked one (clampPlacement's box), each widened by levelSite's 48x48
// footprint (origin-8 .. origin+39). It stops well short of isSceneBuilt's probe points, so
// bulldozing it never makes a built plot read as unbuilt.
function buildArea(o) {
  return { x0: o.x - 20, x1: o.x + 132, z0: o.z - 20, z1: o.z + 132 };
}

// Bulldoze the plot's build zone back to clean, flat ground. Uses /fill via an opped bot -
// instant, no server restart, and the scene around it (decoration, shore, peaks) is untouched.
//
// It clears the ZONE, not the list of sites we remember placing builds on, and that distinction
// is the whole feature: `state.sceneSites` lives in this process, the world lives on disk. Come
// back to a plot tomorrow and the houses are still standing while the list is empty - clearing
// "every site we know about" would then be a no-op on a plot covered in buildings.
async function clearPlot(bot, o) {
  const b = buildArea(o);
  await fillRegion(bot, b.x0, o.y, b.z0, b.x1, o.y + 59, b.z1, 'air');
  await fillRegion(bot, b.x0, o.y - 4, b.z0, b.x1, o.y - 1, b.z1, groundBlock());
}

async function clearAllSites() {
  if (state.busy) throw new Error('A build is already running.');
  state.busy = true;
  setPhase('clearing', { last: null });
  console.log('\n[Web] Clearing the ground - bulldozing the whole build area...');
  try {
    await ensureCrew();
    const lead = crew.activeWorkers[0];
    // /fill only reaches loaded chunks: stand in the middle of the zone before levelling it.
    await lead.teleportTo(baseOrigin.x + 56, baseOrigin.y, baseOrigin.z + 56);
    await sleep(600);
    await clearPlot(lead.bot, baseOrigin);
    // The marker outline sits at o.y-1 inside the zone, so the re-laid ground already erased it.
    state.marker = null;
    state.placement = null;
    sites().length = 0;
    await formation(baseOrigin);
    setPhase('done', { last: { name: 'Ground cleared', blocks: 0, prompt: 'clear' } });
    console.log('[Web] Ground cleared - fresh slate.');
  } catch (err) {
    console.error(`[Web] Clear failed: ${err.message}`);
    setPhase('error', { last: { name: 'Clear failed', blocks: 0, prompt: err.message } });
  } finally {
    state.busy = false;
    broadcast({ type: 'status', ...publicState() });
  }
}

// --- scene construction -----------------------------------------------------------
// Go to a scene. Each scene has its own PERMANENT plot, so it's only ever built
// once - the first visit constructs it (clean flat platform, solid encased base so
// no caves show underneath, themed surface, edge decoration); every visit after is
// an instant teleport, because the world is saved to disk. `force` reconstructs the
// whole plot - platform, surface and decoration - from scratch. ("Clear ground" does
// NOT force: it bulldozes the build zone and leaves the scene's scenery standing.)
async function buildScene(id, { force = false } = {}) {
  const sc = SCENES[id];
  if (state.busy) throw new Error('A build is already running.');
  state.busy = true;
  const o = plotAnchor(id);
  const knownBuilt = !force && state.builtScenes.has(id);
  setPhase('switching', { last: null });   // provisional; flips to building_scene only if we actually build
  try {
    await ensureCrew();
    const lead = crew.activeWorkers[0];
    // Take the marker down while the crew is still standing on the plot that has it -
    // its chunks are loaded here and won't be once we teleport away.
    await eraseMarker();
    state.placement = null;
    baseOrigin = { x: o.x, y: o.y, z: o.z };
    state.background = id;
    // Move the view to the new plot FIRST, so the user watches this scene go down instead of
    // staring at the old one until it's finished. Scene plots are 320 blocks apart, so the
    // camera has to make the trip - it renders 8 chunks, not 20.
    await aimCamera(o);
    const b = sceneBounds(o);
    // Decide whether the plot needs constructing. Known-built (this session) skips
    // straight to the teleport; otherwise park the crew above the plot, let its
    // chunks stream in, and probe for a scene built in a previous session.
    // The lead bot must be at the plot to build/probe (fills need loaded chunks).
    const parkAbove = () => Promise.all(crew.activeWorkers.map((w, i) => w.teleportTo(o.x + 56 + i * 2, o.y + 40, o.z + 56)));
    let needBuild = force || !knownBuilt;
    if (needBuild && !force) {
      await parkAbove();
      await sleep(1200);
      needBuild = !(await isSceneBuilt(lead.bot, o, sc));
    }
    // Lay the whole scene. `lead.bot` is read fresh on every command on purpose: if the lead
    // drops and reconnects, the Worker object survives but its bot does not, and a captured
    // `bot` would keep talking to the dead one.
    const construct = async () => {
      console.log(`[Web] Clearing the ground and laying the ${sc.label} platform...`);
      await fillRegion(lead.bot, b.x0, o.y, b.z0, b.x1, o.y + 19, b.z1, 'air');            // shear off everything above (dunes, trees, hills)
      await fillRegion(lead.bot, b.x0, o.y - 24, b.z0, b.x1, o.y - 3, b.z1, sc.support);   // solid encasing base (hides caves), also bridges any dip in the terrain
      await fillRegion(lead.bot, b.x0, o.y - 2, b.z0, b.x1, o.y - 1, b.z1, sc.ground);     // themed flat surface
      if (sc.shore) {
        console.log(`[Web] Cutting the shoreline (sand sloping into the sea)...`);
        await buildShore(lead.bot, o, b, sc);
      }
      // The tint. Without this the blocks are right but the COLOURS are the old biome's:
      // grass_block in a desert renders dry olive, and a biome seam across the plot shows
      // up as a patch of a different green. Covers the shore water too (water is tinted).
      console.log(`[Web] Painting the ${sc.label} biome...`);
      await fillBiome(lead.bot, b.x0, o.y - 20, b.z0, b.x1, o.y + 20, b.z1, sc.biome);
      // The sea gets its own biome on top: water colour is a tint, so a `beach`-biome sea
      // is the same flat navy as a river, while `warm_ocean` gives the turquoise shallows
      // that make the shoreline actually look tropical. Only the apron ring - the dry
      // platform keeps the scene's own biome, so the sand and foliage stay right.
      if (sc.shore && sc.waterBiome) {
        for (const r of frameStrips(b, 0, SHORE_W))
          await fillBiome(lead.bot, r.x0, SEA_Y - SHORE_DEPTH, r.z0, r.x1, o.y + 20, r.z1, sc.waterBiome);
      }
      console.log(`[Web] Dressing the ${sc.label} scene...`);
      if (sc.decorate) await sc.decorate(lead.bot, o, b);
      // The stamp goes down LAST, once every fill above has landed. It is what marks the plot
      // as finished, so stamping a scene that only half-built would cache the damage forever.
      put(lead.bot, o.x, o.y - 30, o.z, SCENE_STAMP);   // buried layout stamp (see isSceneBuilt)
      await sleep(60);
    };

    if (needBuild) {
      setPhase('building_scene');
      console.log(`\n[Web] Building the ${sc.label} scene (first time)...`);
      // Retry once. A scene is thousands of chunk-rewriting commands, and a server that busy
      // can starve its own keepalives long enough to drop a bot (see MC_TIMEOUT in src/bot.js).
      // assertLead() turns that into a real error instead of a silently half-built scene, and
      // every fill here is idempotent, so starting over is always safe.
      for (let attempt = 1; ; attempt++) {
        try {
          await parkAbove();
          await sleep(1200);   // let the plot's chunks stream in - fills need them loaded
          await construct();
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          console.warn(`[Web] Scene build interrupted (${err.message}) - reconnecting and starting over...`);
          await ensureCrew();
        }
      }
      await refreshChunks(o);            // make the new biome tint actually reach the viewer
      state.sceneNonce++;                // tell the page to re-frame even if the scene name is unchanged
      state.sceneSites[id] = [];         // a freshly built plot starts empty
    } else {
      console.log(`\n[Web] Switching to the ${sc.label} scene (already built)...`);
    }
    state.builtScenes.add(id);
    await formation(o);
    await aimCamera(o);   // each scene is its own plot 320 blocks away - the view has to travel too
    setPhase('done', { last: { name: `${sc.label} scene ready`, blocks: 0, prompt: 'scene' } });
    console.log(`[Web] ${sc.label} scene ready - build grid anchored at (${o.x}, ${o.y}, ${o.z}).`);
  } catch (err) {
    console.error(`[Web] Scene failed: ${err.message}`);
    setPhase('error', { last: { name: 'Scene failed', blocks: 0, prompt: err.message } });
  } finally {
    state.busy = false;
    broadcast({ type: 'status', ...publicState() });
  }
}

// --- viewer reverse proxy ---------------------------------------------------------
// The prismarine viewer runs on its own internal port but is served through THIS
// server under /viewer/, so the user only ever needs one URL. The viewer client
// derives its socket.io path from the page URL (location.pathname + 'socket.io'),
// and the viewer server is started with { prefix: '/viewer' } to match - the proxy
// is a pure pass-through, no path rewriting.
//
// Click-to-place needs the viewer's CAMERA, which its bundle never puts on `window`. The hook
// that gets hold of it anyway now lives in src/viewer-hook.js, because the visual critic
// (src/shot.js) needs exactly the same thing in a headless page. If it ever stops working the
// page just falls back to the automatic grid; placement is a nicety.
const VIEWER_HOOK = VIEWER_HOOK_TAG;

function proxyToViewer(req, res) {
  // Only the viewer's own HTML page gets the hook - everything else (the bundle, assets,
  // socket.io polling) is a straight pass-through.
  const isPage = /^\/viewer\/(index\.html)?(\?|$)/.test(req.url);
  const upstream = http.request({
    host: '127.0.0.1', port: VIEWER_PORT, path: req.url,
    method: req.method, headers: { ...req.headers, host: `127.0.0.1:${VIEWER_PORT}` },
  }, (ures) => {
    if (!isPage || !/text\/html/.test(ures.headers['content-type'] || '')) {
      res.writeHead(ures.statusCode, ures.headers);
      return ures.pipe(res);
    }
    const chunks = [];
    ures.on('data', (c) => chunks.push(c));
    ures.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8').replace('</head>', `${VIEWER_HOOK}</head>`);
      const body = Buffer.from(html, 'utf8');
      res.writeHead(ures.statusCode, { ...ures.headers, 'content-length': body.length });
      res.end(body);
    });
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<body style="background:#0f1216;color:#8b98a5;font:14px sans-serif;display:flex;align-items:center;justify-content:center;height:95vh;text-align:center">' +
      'Browser viewer unavailable (the `canvas` module may be missing - see docs/SETUP.md).<br>The builds still run - watch in the Minecraft game instead.</body>');
  });
  req.pipe(upstream);
}

// --- HTTP server ----------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${WEB_PORT}`);

  // Every POST spends or changes something; only the panel's own page may send one.
  if (req.method === 'POST' && !isAllowedRequest({ origin: req.headers.origin, host: req.headers.host, bind: WEB_BIND })) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'forbidden origin' }));
  }

  if (url.pathname === '/viewer') { res.writeHead(302, { Location: '/viewer/' }); return res.end(); }
  if (url.pathname.startsWith('/viewer/')) return proxyToViewer(req, res);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...publicState(), builds: listBuilds(),
      backgrounds: Object.entries(SCENES).map(([id, b]) => ({ id, label: b.label })),
    }));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'status', ...publicState() })}\n\n`);
    for (const line of logBuffer) res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/build') {
    if (!isJsonContentType(req.headers['content-type'])) { res.writeHead(415, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'expected application/json' })); }
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const prompt = (payload.prompt || '').toString().trim();
    const preset = (payload.preset || '').toString().trim();
    // A preset is library geometry that the preset audit already simulates block by block -
    // there is nothing for a vision model to find and no reason to pay for one. Only a prompt
    // build can be reviewed.
    const review = Boolean(payload.review) && state.canReview && !preset;
    if (state.busy) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'busy' })); }
    if (!prompt && !preset) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'empty' })); }
    runBuild({ prompt, preset, review }).catch((e) => console.error('[Web]', e.message));   // fire-and-forget
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && url.pathname === '/background') {
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const id = (payload.background || '').toString();
    if (!SCENES[id]) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'unknown scene' })); }
    if (state.busy) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'busy' })); }
    buildScene(id).catch((e) => console.error('[Web]', e.message));   // fire-and-forget
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && url.pathname === '/clear') {
    if (state.busy) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'busy' })); }
    if (!state.builtScenes.has(state.background)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'the scene is not built yet' })); }
    clearAllSites().catch((e) => console.error('[Web]', e.message));   // fire-and-forget
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Stake out where the next build goes. The page turns a click in the 3D view into
  // world x/z (a ray from the camera through the cursor, intersected with the ground
  // plane) and posts it here.
  if (req.method === 'POST' && url.pathname === '/place') {
    const body = await readBody(req);
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch { /* ignore */ }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad point' })); }
    if (state.busy) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'busy' })); }
    placeAt(p.x, p.z).catch((e) => console.error('[Web]', e.message));   // fire-and-forget
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && url.pathname === '/place/auto') {
    if (state.busy) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'busy' })); }
    clearPlacement().catch((e) => console.error('[Web]', e.message));   // fire-and-forget
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404); res.end('not found');
});

// socket.io upgrades from HTTP polling to a websocket - tunnel those raw to the
// viewer by replaying the upgrade request over a plain TCP pipe.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/viewer/')) return socket.destroy();
  const upstream = net.connect(VIEWER_PORT, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(raw + '\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

// --- startup --------------------------------------------------------------------
async function main() {
  console.log('\n  Minecraft Agentic Builder - Web UI\n');

  // Listen and open the browser BEFORE the slow work, not after it. Booting the server
  // and the crew takes the better part of a minute, and doing it first meant every bit
  // of that progress landed in the terminal only - the browser then opened on a panel
  // that was already finished. Now the page is up front, so the boot streams into it.
  //
  // A busy port is almost always another panel (two can't share a server anyway - the
  // bots' fixed usernames mean the second crew kicks the first with duplicate_login),
  // so say that instead of dying with a stack trace.
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      console.error(`\x1b[31m✖ Port ${WEB_PORT} is already in use - another panel is probably running.\x1b[0m`);
      console.error(`  Either use the one that's up:   http://localhost:${WEB_PORT}`);
      console.error(`  Or stop it and run this again:  pkill -f 'scripts/w[e]b.js'`);
      console.error(`  (Different port: WEB_PORT=8081 npm run web)\n`);
      process.exit(1);
    });
    server.listen(WEB_PORT, WEB_BIND, resolve);
  });
  console.log('========================================================');
  console.log(`  OPENING IN YOUR BROWSER:  http://localhost:${WEB_PORT}`);
  console.log(`  (watch the crew boot there - prompt box + live 3D view)`);
  console.log('========================================================\n');
  openBrowser(`http://localhost:${WEB_PORT}`);

  try {
    setBoot('server', 'active');
    await ensureServerUp();
    setBoot('server', 'done');

    // assembleTeam() pacifies the world for us (see src/world.js): peaceful, no weather,
    // permanent noon - so nothing wanders into frame or snows on a finished scene.
    setBoot('crew', 'active');
    crew = new Crew(null, { host: process.env.MC_HOST || 'localhost', port: parseInt(process.env.MC_PORT || '25565', 10) });
    await crew.assembleTeam(['mason', 'carpenter', 'decorator', 'landscaper']);
    setBoot('crew', 'done');

    // Anchor scenes at the stable WORLD spawn (not the crew's saved position, which
    // drifts as they build) at a fixed height, then start the viewer.
    setBoot('viewer', 'active');
    const bot = crew.activeWorkers[0].bot;
    const sp = bot.spawnPoint || bot.entity.position;
    baseOrigin = { x: Math.floor(sp.x) + 6, y: STAGE_Y, z: Math.floor(sp.z) + 6 };
    SPAWN = { ...baseOrigin };   // every scene is constructed here
    await formation(baseOrigin);
    // The view renders from the CAMERA bot, which is parked here and then holds still for
    // the rest of the session (see src/camera.js). A moving viewer bot churns chunk columns
    // and prismarine-viewer silently drops the mesh jobs that were in flight, freezing whole
    // chunk sections mid-build - that is what produced a roofless cottage with its ridge beam
    // hanging in the air while the real world had a perfectly good roof.
    await aimCamera(baseOrigin);
    VIEWER_PORT = await findFreePort(VIEWER_PORT);   // never let a stale port disable the view
    await startViewer(crew.viewerBot(), { prefix: '/viewer', quiet: true, port: VIEWER_PORT });
    viewerReady = true;
    setBoot('viewer', 'done');
  } catch (e) {
    bootFailed(e.message);   // leave the boot screen up with the failure, don't just die silently
    throw e;
  }

  boot.done = true;
  broadcast({ type: 'status', ...publicState() });   // the page swaps the boot screen for the panel

  // Construct a clean Plains scene right away so the very first thing the user sees
  // is a tidy flat starting point, not raw spawn terrain. Fire-and-forget, and left
  // OUTSIDE the boot gate on purpose: the panel is usable immediately and the platform
  // going down is the first thing you watch the crew do in the 3D view.
  buildScene('spawn').catch((e) => console.error('[Web]', e.message));
}

// Disconnect the bots on exit so a quick restart doesn't collide with our own
// still-connected bots (same usernames -> "duplicate_login" kick on the new run).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[Web] Shutting down - disbanding the crew...');
  try { if (crew) await crew.disbandTeam(); } catch { /* noop */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => { console.error('\n[Web] Fatal:', e.message); process.exit(1); });

// --- the page (inlined so there are no static assets to serve) ------------------
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minecraft Agentic Builder</title>
<style>
  :root {
    --bg:#0f1216; --panel:#171b21; --panel2:#1c222a; --edge:#252c35; --edge2:#323b47;
    --ink:#e6edf3; --dim:#8b98a5; --accent:#3fb950; --accent2:#58a6ff; --danger:#f85149;
  }
  * { box-sizing:border-box; }
  /* Stylized scrollbars everywhere (Firefox + WebKit) */
  * { scrollbar-width:thin; scrollbar-color:var(--edge2) transparent; }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--edge2); border-radius:999px; border:2px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:#465264; background-clip:padding-box; }
  ::-webkit-scrollbar-corner { background:transparent; }
  html, body { overflow-x:hidden; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--edge); background:linear-gradient(180deg,var(--panel2),var(--panel)); }
  header h1 { font-size:16px; margin:0; font-weight:700; letter-spacing:.01em; }
  header h1 .pick { opacity:.55; font-weight:500; }
  .badge { margin-left:auto; font-size:12px; padding:4px 11px; border-radius:999px; border:1px solid var(--edge2); color:var(--dim); white-space:nowrap; }
  .badge.live { color:var(--accent); border-color:#1f6f36; background:#0e2a17; }
  main { display:grid; grid-template-columns:390px minmax(0,1fr); gap:0; height:calc(100vh - 53px); }
  @media (max-width:820px){ main { grid-template-columns:1fr; height:auto; } .viewer { height:60vh; } }
  .panel { padding:18px; border-right:1px solid var(--edge); display:flex; flex-direction:column; gap:16px; min-width:0; overflow:hidden; }
  .field { display:flex; flex-direction:column; gap:7px; min-width:0; }
  .row { display:flex; gap:8px; min-width:0; }
  input[type=text] { flex:1; min-width:0; background:#0b0e12; border:1px solid var(--edge2); color:var(--ink); padding:11px 13px; border-radius:9px; font-size:14px; transition:border-color .15s, box-shadow .15s; }
  input[type=text]::placeholder { color:#5f6b78; }
  input[type=text]:focus { outline:0; border-color:var(--accent2); box-shadow:0 0 0 3px rgba(88,166,255,.15); }
  input[type=text]:disabled { opacity:.45; cursor:not-allowed; }
  button { background:var(--accent); color:#04140a; border:0; padding:11px 18px; border-radius:9px; font-weight:700; cursor:pointer; transition:filter .15s, transform .05s; white-space:nowrap; }
  button:hover:not(:disabled){ filter:brightness(1.08); }
  button:active:not(:disabled){ transform:translateY(1px); }
  button:disabled { opacity:.4; cursor:not-allowed; }
  button.ghost { background:var(--panel2); border:1px solid var(--edge2); color:var(--ink); font-weight:600; padding:8px 13px; font-size:13px; }
  button.ghost:hover:not(:disabled){ border-color:var(--accent2); color:var(--accent2); background:#182130; filter:none; }
  button.ghost.active { border-color:var(--accent); color:var(--accent); }
  button.ghost.danger { padding:5px 11px; font-size:12px; flex:none; background:transparent; }
  button.ghost.danger:hover:not(:disabled){ border-color:var(--danger); color:var(--danger); background:#1f1315; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .hint { color:var(--dim); font-size:12px; margin:0; }
  .status { padding:11px 13px; border-radius:9px; background:#0b0e12; border:1px solid var(--edge2); font-size:13px; min-height:42px; display:flex; align-items:center; gap:9px; }
  .status #statusText { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none; }
  .dot.busy { background:var(--accent2); animation:pulse 1s infinite; box-shadow:0 0 0 3px rgba(88,166,255,.18); }
  .dot.done { background:var(--accent); } .dot.error { background:var(--danger); }
  @keyframes pulse { 50%{ opacity:.35; } }
  .logwrap { flex:1; display:flex; flex-direction:column; gap:7px; min-height:0; }
  .log { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; background:#080b0e; border:1px solid var(--edge); border-radius:9px; padding:11px 12px; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; color:#b9c5d1; }
  .log .l { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
  .log .l.crew { color:#7ee2a8; } .log .l.coord { color:#9db8ff; } .log .l.me { color:#e3b341; }
  .log:empty::before { content:'Waiting for build activity...'; color:#5f6b78; }
  .viewer { position:relative; background:#000; min-width:0; overflow:hidden; }
  .viewer iframe { width:100%; height:100%; border:0; display:block; }
  /* Viewer preloader - covers the pane from iframe src to "the world is actually meshed".
     The iframe's load event fires when the HTML arrives, which is 10-40s BEFORE the chunks
     stream in and mesh; dismissing on load left a black pane that read as frozen. */
  .vload { position:absolute; inset:0; z-index:5; display:flex; align-items:center; justify-content:center;
           background:radial-gradient(700px 420px at 50% 30%, #16202b, #0b0e12 75%); transition:opacity .6s ease; }
  .vload.gone { opacity:0; pointer-events:none; }
  .vload canvas { position:absolute; inset:0; width:100%; height:100%; }
  .vinner { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:6px; }
  .vmark { font-size:44px; filter:drop-shadow(0 6px 18px rgba(63,185,80,.35)); animation:bob 2.2s ease-in-out infinite; }
  @keyframes bob { 50% { transform:translateY(-6px); } }
  .vtitle { font-size:22px; font-weight:800; letter-spacing:.01em; margin-bottom:10px; }
  .vtitle .g { color:var(--accent); } .vtitle .b { color:var(--accent2); }
  .vbar { width:210px; height:6px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden; }
  .vbar div { height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .3s ease; }
  .vpct { font-size:13px; font-weight:700; color:var(--ink); opacity:.85; }
  .vmsg { font-size:12px; color:var(--dim); min-height:18px; }
  .vsub { font-size:11px; color:#5f6b78; margin-top:8px; }
  .aim { position:absolute; top:0; left:0; right:0; padding:10px; text-align:center; font-weight:600; font-size:13px;
         background:linear-gradient(180deg,rgba(63,185,80,.92),rgba(63,185,80,0)); color:#04140a; pointer-events:none; }
  .aim[hidden] { display:none; }
  label.small { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; font-weight:600; }
  .inline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .verdict { border:1px solid var(--edge2); border-left:3px solid var(--accent2); border-radius:8px;
             background:var(--panel2); padding:9px 12px; font-size:12px; color:var(--dim); }
  .verdictHead { color:var(--ink); font-size:13px; margin-bottom:4px; }
  .verdict ul { margin:0; padding-left:16px; }
  .verdict li { margin:2px 0; }

  /* Boot screen - the server/crew/viewer startup, which the terminal used to keep to itself. */
  .boot { position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; padding:24px;
          background:radial-gradient(900px 520px at 50% -10%, #1d2733, var(--bg) 70%); transition:opacity .5s ease; }
  .boot.gone { opacity:0; pointer-events:none; }
  .boot canvas { position:absolute; inset:0; width:100%; height:100%; }
  .bootcard { position:relative; z-index:1; width:min(560px,100%); background:var(--panel); border:1px solid var(--edge); border-radius:16px;
              padding:26px 26px 20px; box-shadow:0 24px 70px rgba(0,0,0,.55); }
  .bootbar { margin-top:16px; height:6px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden; }
  .bootbar div { height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .4s ease; }
  .bootcard .pick { font-size:30px; }
  .bootcard h2 { margin:10px 0 6px; font-size:19px; }
  .steps { list-style:none; margin:18px 0 0; padding:0; }
  .steps li { display:flex; align-items:center; gap:11px; padding:9px 10px; border-radius:9px; font-size:13.5px; color:var(--dim); }
  .steps li.active { background:#0b0e12; color:var(--ink); }
  .steps li.done { color:var(--ink); }
  .steps li.failed { color:var(--danger); }
  .ic { width:17px; height:17px; flex:none; border-radius:50%; border:2px solid var(--edge2); position:relative; }
  li.active .ic { border-color:var(--accent2); border-top-color:transparent; animation:spin .7s linear infinite; }
  li.done .ic { border-color:var(--accent); background:var(--accent); }
  li.done .ic::after { content:''; position:absolute; left:4.5px; top:1px; width:4px; height:8px;
                       border:solid #04140a; border-width:0 2px 2px 0; transform:rotate(45deg); }
  li.failed .ic { border-color:var(--danger); background:var(--danger); }
  @keyframes spin { to { transform:rotate(360deg); } }
  /* Tail of the same log the panel shows, so a slow step never looks like a hang. */
  .bootlog { margin-top:16px; height:104px; overflow:hidden; background:#080b0e; border:1px solid var(--edge);
             border-radius:9px; padding:9px 11px; font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
             color:#6f7d8b; display:flex; flex-direction:column; justify-content:flex-end; }
  .bootlog div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .booterr { margin-top:14px; padding:10px 12px; border-radius:9px; background:#1f1315; border:1px solid #5c2a2a;
             color:var(--danger); font-size:13px; }
  .booterr[hidden] { display:none; }
</style></head>
<body>
<div class="boot" id="boot">
  <canvas id="bootfx"></canvas>
  <div class="bootcard">
    <div class="pick">&#9935;</div>
    <h2>Warming up the build site</h2>
    <p class="hint">Booting the Minecraft server, spawning the crew, and starting the 3D view.
      The very first run takes a minute - the world has to generate from scratch.</p>
    <div class="bootbar"><div id="bootbarFill"></div></div>
    <ul class="steps" id="bootsteps"></ul>
    <div class="booterr" id="booterr" hidden></div>
    <div class="bootlog" id="bootlog"></div>
  </div>
</div>
<header>
  <h1>&#9935; Minecraft Agentic Builder <span class="pick">- crew control</span></h1>
  <span id="badge" class="badge">-</span>
</header>
<main>
  <section class="panel">
    <div class="field">
      <label class="small" for="prompt">Describe a build</label>
      <div class="row">
        <input id="prompt" type="text" placeholder="a haunted mansion with a graveyard" autocomplete="off">
        <button id="go">Build</button>
      </div>
      <p id="hint" class="hint"></p>
      <label id="reviewRow" class="inline hint" style="display:none">
        <input id="review" type="checkbox">
        <span>Critique it when it's done - the AI looks at the finished build and fixes what it sees</span>
      </label>
      <div id="verdict" class="verdict" style="display:none"></div>
    </div>
    <div class="field">
      <label class="small">Or pick a preset (always free)</label>
      <div id="chips" class="chips"></div>
    </div>
    <div class="field">
      <label class="small">Scene - a pretty flat starting point</label>
      <div id="bgs" class="chips"></div>
    </div>
    <div class="field">
      <label class="small">Where to build</label>
      <div class="inline">
        <button id="place" class="ghost">Pick a spot</button>
        <button id="auto" class="ghost">Auto</button>
        <span id="placeInfo" class="hint"></span>
      </div>
    </div>
    <div class="status"><span id="dot" class="dot"></span><span id="statusText">Connecting...</span>
      <button id="clear" class="ghost danger" style="margin-left:auto" title="Bulldoze every build and re-grass the ground" disabled>Clear ground</button>
    </div>
    <div class="logwrap">
      <label class="small">Live build log</label>
      <div id="log" class="log"></div>
    </div>
  </section>
  <section class="viewer">
    <!-- src is set once boot completes: the viewer's port isn't even chosen until then,
         so loading it up front would just latch the iframe onto the proxy's 502 page. -->
    <iframe id="view" title="build viewer"></iframe>
    <div class="vload" id="vload">
      <canvas id="vloadfx"></canvas>
      <div class="vinner">
        <div class="vmark">&#9935;</div>
        <div class="vtitle"><span class="g">Minecraft</span> <span class="b">Agentic</span></div>
        <div class="vbar"><div id="vbarFill"></div></div>
        <div class="vpct" id="vpct">0%</div>
        <div class="vmsg" id="vmsg">Connecting to the world...</div>
        <div class="vsub">drag to orbit &middot; scroll to zoom</div>
      </div>
    </div>
    <div class="aim" id="aim" hidden>Click the ground where the crew should build</div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let live = false, busy = false, lastBg, lastNonce, surfaceY = 72, aiming = false;
  let booted = false, viewerStarted = false, firstStatus = true;

  // --- particle field (the house preloader backdrop) -----------------------------
  // A drifting constellation in the panel's accent colours, drawn on a canvas behind
  // whichever overlay is up. Returns a stop() that ends the animation loop.
  function startFx(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    let raf = 0, alive = true;
    const fit = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    fit();
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    const colors = ['#3fb950', '#58a6ff', '#9db8ff', '#ffffff'];
    const ps = [];
    for (let i = 0; i < 36; i++) ps.push({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      vx: (Math.random() - .5) * .45, vy: (Math.random() - .5) * .45,
      r: Math.random() * 1.8 + .8, a: Math.random() * .4 + .12,
      c: colors[Math.floor(Math.random() * colors.length)],
    });
    const step = () => {
      if (!alive) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of ps) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
        ctx.globalAlpha = p.a; ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 110) {
          ctx.globalAlpha = (1 - d / 110) * .13; ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = .5;
          ctx.beginPath(); ctx.moveTo(ps[i].x, ps[i].y); ctx.lineTo(ps[j].x, ps[j].y); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(step);
    };
    step();
    return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }

  // --- boot screen --------------------------------------------------------------
  // Driven off status.boot, which every /status and every SSE status frame carries - so
  // opening the page late (or reloading mid-boot) lands on the right screen with no
  // special-casing. The steps come from the server rather than being timed here, because
  // "waiting for the world to generate" has no predictable duration to fake a bar against.
  // The bar crawls within the active step (a spinner alone reads as frozen over a slow
  // step like first-run world generation) and snaps forward when a real step completes.
  let bootFx = null, bootTick = 0, bootCur = 0;
  function bootBar(b) {
    const total = b.steps.length || 1;
    const done = b.steps.filter((s) => s.state === 'done').length;
    const active = b.steps.some((s) => s.state === 'active');
    const cap = b.done ? 100 : (done / total) * 100 + (active ? (1 / total) * 88 : 0);
    if (!bootTick) bootTick = setInterval(() => {
      const target = bootCur < cap ? cap : bootCur;
      bootCur = Math.min(target, bootCur + Math.max(.06, (target - bootCur) * .06));
      $('bootbarFill').style.width = bootCur.toFixed(1) + '%';
    }, 150);
    if (b.done) { bootCur = 100; $('bootbarFill').style.width = '100%'; }
  }
  function renderBoot(b) {
    if (!b || booted) return;
    // Reloading an already-booted panel: the overlay is in the markup, so it has already
    // painted by the time this first status lands. Cut straight to the panel instead of
    // playing a fade the user reads as a spurious flash of a loading screen.
    if (b.done && firstStatus) {
      booted = true; firstStatus = false;
      showViewer();
      $('boot').style.display = 'none';
      return;
    }
    firstStatus = false;
    if (!bootFx) bootFx = startFx($('bootfx'));
    bootBar(b);
    const ul = $('bootsteps');
    ul.textContent = '';
    b.steps.forEach((s) => {
      const li = document.createElement('li');
      li.className = s.state;
      const ic = document.createElement('span'); ic.className = 'ic';
      const tx = document.createElement('span'); tx.textContent = s.label;
      li.appendChild(ic); li.appendChild(tx);
      ul.appendChild(li);
    });
    $('booterr').hidden = !b.error;
    if (b.error) $('booterr').textContent = 'Boot failed: ' + b.error + ' (see the terminal)';
    if (!b.done) return;
    booted = true;
    showViewer();
    $('boot').classList.add('gone');
    setTimeout(() => {
      $('boot').style.display = 'none';
      if (bootFx) { bootFx(); bootFx = null; }
      clearInterval(bootTick); bootTick = 0;
    }, 550);
  }

  // --- viewer preloader ----------------------------------------------------------
  // Covers the 3D pane from "iframe gets a src" until the world is actually MESHED.
  // Progress is real, not a timer: the injected hook (src/viewer-hook.js) collects the
  // viewer's three.js scenes on window.__scenes, and the iframe is same-origin (we proxy
  // it), so this page can watch the biggest scene's child count - one child per meshed
  // chunk section - grow and settle. Stages: HTML loaded -> camera locked (window.__cam,
  // set by the same hook on the first to-screen render) -> sections meshing -> settled.
  const vl = { fx: null, poll: 0, tick: 0, cur: 0, cap: 0, best: 0, t0: 0, grew: 0, html: false, sawCam: false };
  function showVload(msg) {
    vl.cur = 0; vl.cap = 4; vl.best = 0; vl.html = false; vl.sawCam = false;
    vl.t0 = performance.now(); vl.grew = vl.t0;
    $('vmsg').textContent = msg || 'Connecting to the world...';
    $('vbarFill').style.width = '0%'; $('vpct').textContent = '0%';
    $('vload').classList.remove('gone');
    if (!vl.fx) vl.fx = startFx($('vloadfx'));
    clearInterval(vl.poll);
    vl.poll = setInterval(pollVload, 250);
    if (!vl.tick) vl.tick = setInterval(() => {
      vl.cur = Math.min(vl.cap, vl.cur + Math.max(.08, (vl.cap - vl.cur) * .09));
      $('vbarFill').style.width = vl.cur.toFixed(1) + '%';
      $('vpct').textContent = Math.round(vl.cur) + '%';
    }, 120);
  }
  function hideVload() {
    vl.cap = 100;
    clearInterval(vl.poll); vl.poll = 0;
    setTimeout(() => {
      $('vload').classList.add('gone');
      setTimeout(() => {
        if (vl.fx) { vl.fx(); vl.fx = null; }
        clearInterval(vl.tick); vl.tick = 0;
      }, 700);
    }, 350);
  }
  function pollVload() {
    let meshes = 0, cam = false;
    try {
      const cw = $('view').contentWindow;
      cam = !!(cw && cw.__cam);
      for (const s of (cw && cw.__scenes) || [])
        if (s.children && s.children.length > meshes) meshes = s.children.length;
    } catch (e) { /* iframe not ready yet */ }
    const now = performance.now();
    if (cam) vl.sawCam = true;
    if (meshes > vl.best) { vl.best = meshes; vl.grew = now; }
    let cap = 4;
    if (vl.html) cap = 12;
    if (vl.sawCam) cap = 24;
    if (vl.best > 0) cap = 24 + 70 * (vl.best / (vl.best + 90));   // asymptote toward 94
    vl.cap = Math.max(vl.cap, cap);
    $('vmsg').textContent = vl.best > 0 ? 'Meshing the world - ' + vl.best + ' sections'
      : vl.sawCam ? 'Camera locked - streaming chunks...'
        : vl.html ? 'Waking the 3D view...' : 'Connecting to the world...';
    // Done when meshing settles; time out rather than trap the user over a pane that will
    // never mesh (e.g. the viewer-unavailable fallback page - its message must be readable).
    const timeout = (vl.sawCam || vl.best) ? 45000 : 20000;
    if ((vl.best >= 24 && now - vl.grew > 2500) || now - vl.t0 > timeout) hideVload();
  }
  function showViewer() {
    if (viewerStarted) return;
    viewerStarted = true;
    showVload();
    $('view').src = '/viewer/';
  }
  function addBootLog(line) {
    const box = $('bootlog');
    const el = document.createElement('div');
    el.textContent = line;
    box.appendChild(el);
    while (box.children.length > 5) box.removeChild(box.firstChild);
  }

  // --- click a spot in the 3D view, build there ---------------------------------
  // The iframe is same-origin (we reverse-proxy the viewer), so we can listen for clicks
  // inside it and read the camera the injected hook parked on its window. Turning a click
  // into world coordinates is then just a ray: unproject the cursor through the camera and
  // intersect it with the scene's ground plane (the viewer's scene is in real world coords,
  // so no conversion needed). No mesh picking, nothing that depends on what's loaded.
  //
  // The vector math runs on the camera's OWN Vector3 (cloned off cam.position) rather than on a
  // freshly constructed w.THREE.Vector3 - the bundle keeps THREE in module scope and never puts
  // it on the window, so reaching for w.THREE is reaching for undefined. The instance carries
  // every method we need (set/unproject/sub/normalize), and it can't go stale.
  function pickGround(w, e) {
    try {
      const cam = w.__cam;
      if (!cam || !cam.position) return null;
      const canvas = w.document && w.document.querySelector('canvas');
      const r = canvas ? canvas.getBoundingClientRect()
                       : { left: 0, top: 0, width: w.innerWidth, height: w.innerHeight };
      if (!r.width || !r.height) return null;
      const p = cam.position.clone()
        .set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5)
        .unproject(cam);
      const d = p.sub(cam.position).normalize();
      if (Math.abs(d.y) < 1e-4) return null;                  // looking along the ground - no hit
      const t = (surfaceY - cam.position.y) / d.y;
      if (t <= 0 || t > 900) return null;                     // behind the camera, or off past the horizon
      return { x: Math.round(cam.position.x + d.x * t), z: Math.round(cam.position.z + d.z * t) };
    } catch (err) { return null; }
  }
  function setAiming(on) {
    aiming = on;
    $('aim').hidden = !on;
    $('place').classList.toggle('active', on);
    try { $('view').contentDocument.body.style.cursor = on ? 'crosshair' : ''; } catch (err) { /* not loaded yet */ }
  }
  function hookViewer() {
    try {
      const w = $('view').contentWindow, doc = w.document;
      let sx = 0, sy = 0;
      // POINTERDOWN, not mousedown: the viewer's orbit controls preventDefault() their
      // pointerdown, and a canceled pointerdown suppresses the compatibility mousedown
      // entirely (click still fires). A mousedown-armed guard never arms, reads every
      // click as a drag from (0,0), and eats it silently.
      doc.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; });
      doc.addEventListener('click', (e) => {
        if (!aiming || busy) return;
        // Orbiting the camera also ends in a click - only treat it as a pick if the
        // pointer didn't travel.
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 5) return;
        const p = pickGround(w, e);
        if (!p) {
          addLog(w.__cam ? '[Web] Could not read that spot - aim at the ground.'
                         : '[Web] The 3D view is still starting up - try that click again.');
          return;
        }
        setAiming(false);
        fetch('/place', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(p) });
      });
    } catch (err) { /* viewer unavailable - placement stays on the automatic grid */ }
  }
  $('view').addEventListener('load', () => { vl.html = true; hookViewer(); });
  $('place').addEventListener('click', () => { if (!busy) setAiming(!aiming); });
  $('auto').addEventListener('click', () => { if (busy) return; setAiming(false); fetch('/place/auto', { method:'POST' }); });

  // The viewer's camera locks onto the bot's position when it CONNECTS, so after
  // the crew travels somewhere new we reload the iframe to re-frame the new scene -
  // no manual page refresh. Query string busts cache; the socket.io path comes from
  // location.pathname (still /viewer/) so the connection is unaffected.
  function reframeViewer(){
    if (!viewerStarted) return;   // still booting - showViewer() will do the first load
    showVload('Travelling to the new scene...');
    $('view').src = '/viewer/?t=' + Date.now();
  }

  function classify(line){
    if (/^\\[Crew\\]/.test(line)) return 'crew';
    if (/^\\[Coordinator\\]/.test(line)) return 'coord';
    if (/^\\[Web\\]/.test(line)) return 'me';
    return '';
  }
  function addLog(line){
    const el = document.createElement('div');
    el.className = 'l ' + classify(line);
    el.textContent = line;
    const box = $('log'); box.appendChild(el); box.scrollTop = box.scrollHeight;
    while (box.children.length > 400) box.removeChild(box.firstChild);
    if (!booted) addBootLog(line);   // same stream, tailed on the boot screen
  }
  function setStatus(s){
    renderBoot(s.boot);
    live = s.live; busy = s.busy;
    if (s.surfaceY) surfaceY = s.surfaceY;
    $('placeInfo').textContent = s.placement
      ? 'Next build: (' + s.placement.x + ', ' + s.placement.z + ')'
      : 'Next build: next free spot on the grid';
    $('place').disabled = s.busy;
    $('auto').disabled = s.busy || !s.placement;
    if (s.busy) setAiming(false);
    // Re-frame on a scene switch, and also on a rebuild-in-place (same name, new world).
    if (lastBg === undefined) { lastBg = s.background; lastNonce = s.sceneNonce; }
    else if (s.background !== lastBg || s.sceneNonce !== lastNonce) {
      lastBg = s.background; lastNonce = s.sceneNonce; reframeViewer();
    }
    $('badge').textContent = s.live ? s.providerLabel : 'no key - library mode';
    $('badge').className = 'badge' + (s.live ? ' live' : '');
    $('prompt').disabled = !s.live;
    $('hint').textContent = s.live
      ? 'Powered by ' + s.providerLabel + '. Type anything.'
      : 'No AI key set - use the presets below, or add a key (Gemini is free) for custom prompts.';
    const dot = $('dot'), t = $('statusText');
    dot.className = 'dot ' + (s.busy ? 'busy' : (s.phase==='done'?'done':s.phase==='error'?'error':''));
    $('go').disabled = s.busy || !s.live;
    $('clear').disabled = s.busy || !s.clearable;
    document.querySelectorAll('#chips button').forEach(b => b.disabled = s.busy);
    document.querySelectorAll('#bgs button').forEach(b => {
      b.disabled = s.busy;
      b.classList.toggle('active', b.dataset.id === s.background);
    });
    // The critique toggle only appears when it can actually run: it needs a model that can
    // look at a picture (src/critic.js), and it never runs on presets.
    $('reviewRow').style.display = s.canReview ? 'flex' : 'none';
    $('review').disabled = s.busy;
    if (s.phase==='planning') t.textContent = 'Designing your build...';
    else if (s.phase==='building') t.textContent = 'Building' + (s.last?' ':'') + '...';
    else if (s.phase==='repairing') t.textContent = 'Fixing the blocks that did not land...';
    else if (s.phase==='reviewing') t.textContent = 'Looking at the finished build...';
    else if (s.phase==='clearing') t.textContent = 'Clearing the ground...';
    else if (s.phase==='building_scene') t.textContent = 'Building the scene (one time)...';
    else if (s.phase==='switching') t.textContent = 'Switching scene...';
    else if (s.phase==='done' && s.last && s.last.prompt==='clear') t.textContent = 'Ground cleared - fresh slate ready';
    else if (s.phase==='done' && s.last && s.last.prompt==='scene') t.textContent = s.last.name + ' - ready to build';
    else if (s.phase==='done' && s.last) t.textContent = 'Done: ' + s.last.name + ' (' + s.last.blocks + ' blocks)'
      + (s.last.repaired ? ' - ' + s.last.repaired + ' repaired' : '')
      + (s.last.missing ? ', ' + s.last.missing + ' MISSING' : '');
    else if (s.phase==='error' && s.last) t.textContent = 'Error: ' + s.last.prompt;
    else t.textContent = busy ? 'Working...' : 'Idle - ready to build';

    const v = $('verdict');
    if (s.review && s.review.verdict) {
      v.style.display = 'block';
      v.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'verdictHead';
      head.textContent = (s.review.score != null ? s.review.score + '/10 - ' : '') + s.review.verdict;
      v.appendChild(head);
      const ul = document.createElement('ul');
      for (const issue of s.review.issues || []) {
        const li = document.createElement('li');
        li.textContent = issue;    // model text - never innerHTML
        ul.appendChild(li);
      }
      v.appendChild(ul);
    } else {
      v.style.display = 'none';
    }
  }

  async function build(payload){
    if (busy) return;
    const r = await fetch('/build', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (r.status === 409) addLog('[Web] A build is already running - wait for it to finish.');
  }
  const wantsReview = () => $('review').checked;
  $('go').addEventListener('click', () => { const p = $('prompt').value.trim(); if (p) build({ prompt: p, review: wantsReview() }); });
  $('clear').addEventListener('click', () => {
    if (busy) return;
    if (!confirm('Bulldoze every build and re-grass the ground?')) return;
    fetch('/clear', { method:'POST' });
  });
  $('prompt').addEventListener('keydown', (e) => { if (e.key==='Enter'){ const p=$('prompt').value.trim(); if(p) build({prompt:p, review: wantsReview()}); } });

  fetch('/status').then(r=>r.json()).then(s => {
    setStatus(s);
    const chips = $('chips');
    (s.builds||[]).forEach(b => {
      const btn = document.createElement('button');
      btn.className='ghost'; btn.textContent = b.name.split(' - ')[0];
      btn.title = b.name; btn.onclick = () => build({ preset: b.id });
      chips.appendChild(btn);
    });
    const rnd = document.createElement('button');
    rnd.className='ghost'; rnd.textContent='Surprise me'; rnd.onclick=()=>build({preset:'random'});
    chips.appendChild(rnd);
    const bgs = $('bgs');
    (s.backgrounds||[]).forEach(b => {
      const btn = document.createElement('button');
      btn.className='ghost'; btn.textContent = b.label; btn.dataset.id = b.id;
      btn.onclick = () => {
        if (busy) return;
        fetch('/background', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ background: b.id }) });
      };
      bgs.appendChild(btn);
    });
    setStatus(s);
  });

  const es = new EventSource('/events');
  es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type==='log') addLog(d.line); else if (d.type==='status') setStatus(d); };
</script>
</body></html>`;
