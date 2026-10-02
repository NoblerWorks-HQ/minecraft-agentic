#!/usr/bin/env node
// Manage the local Minecraft server with plain `docker` (no compose plugin needed).
//   node scripts/server.js up      # start it (create or restart the container), wait until ready
//   node scripts/server.js stop    # stop it (world is kept)
//   node scripts/server.js reset   # stop + delete the container AND the world
//   node scripts/server.js status  # is it up?
import { execSync } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'minecraft-agentic';
const IMAGE = 'itzg/minecraft-server:java21';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VOLUME = 'minecraft-agentic-data';

// RAISED superflat: solid rock from bedrock to a grass surface at y=63 (stand at y=64).
// Flat on purpose - normal terrain generates caverns under every plot, and nothing in this
// project ever goes underground; the scenes' "solid encased base" only ever papered over
// the caves directly beneath a platform. NOTE the layer heights: a DEFAULT superflat's
// surface sits at y=-60, and prismarine-viewer never meshes sections below y=0 (its
// worldrenderer loops y 0..255), so a default flat world renders as empty sky in the
// browser. The 128 layers below put the surface at y=63 - comfortably above that floor
// and one block over the panel's SEA_Y=62, so shore scenes still flood correctly.
// Takes effect only at world CREATION: changing this needs `npm run server:reset`.
const GENERATOR_SETTINGS = JSON.stringify({
  layers: [
    { block: 'minecraft:bedrock', height: 1 },
    { block: 'minecraft:deepslate', height: 63 },
    { block: 'minecraft:stone', height: 61 },
    { block: 'minecraft:dirt', height: 2 },
    { block: 'minecraft:grass_block', height: 1 },
  ],
  biome: 'minecraft:plains',
});

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;

function sh(cmd, opts = {}) { return execSync(cmd, { stdio: 'pipe', ...opts }).toString().trim(); }
function quiet(cmd, opts = {}) { try { return sh(cmd, opts); } catch { return null; } }

function requireDocker() {
  try { execSync('docker info', { stdio: 'ignore' }); }
  catch {
    console.error(r('\n✖ Docker is not running.'));
    console.error('  Install Docker Desktop (docker.com/products/docker-desktop) and start it, then try again.\n');
    process.exit(1);
  }
}

function containerState() {
  // returns 'running' | 'exited' | 'missing'
  const out = quiet(`docker inspect -f "{{.State.Status}}" ${NAME}`);
  return out || 'missing';
}

function portOpen() {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
    s.connect(PORT, process.env.MC_HOST || 'localhost');
  });
}

// True once Minecraft has fully booted THIS run of the container. The mapped port
// opens the moment Docker starts (docker-proxy answers), long before the world is
// generated - connecting then gets the bot an EPIPE. The reliable signal is the
// server's "Done (12.345s)!" log line, scoped to the current boot via StartedAt.
function mcBootedInLogs() {
  const started = quiet(`docker inspect -f "{{.State.StartedAt}}" ${NAME}`);
  if (!started) return false;
  // big maxBuffer: a long-running server can have many MB of logs this boot
  const logs = quiet(`docker logs --since ${started} ${NAME} 2>&1`, { maxBuffer: 64 * 1024 * 1024 }) || '';
  return /\]: Done \([\d.]+s\)!/.test(logs);
}

async function waitUntilReady(maxSeconds = 180) {
  process.stdout.write('  waiting for the world to be ready');
  for (let i = 0; i < maxSeconds; i += 2) {
    if (await portOpen() && mcBootedInLogs()) { process.stdout.write('\n'); return true; }
    process.stdout.write('.');
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  process.stdout.write('\n');
  return false;
}

export async function ensureServerUp() {
  requireDocker();
  const state = containerState();

  if (state === 'running') {
    if (await portOpen() && mcBootedInLogs()) { console.log(g(`✔ Server already running on port ${PORT}`)); return; }
    console.log(y('• Server container is up but still starting...'));
  } else if (state === 'exited') {
    console.log(`• Starting existing server container...`);
    sh(`docker start ${NAME}`);
  } else {
    console.log('• Creating the Minecraft server (first run downloads the image + generates the world)...');
    const opsMount = `${path.join(ROOT, 'docker', 'ops.json')}:/data/ops.json`;
    sh([
      'docker run -d',
      `--name ${NAME}`,
      // Loopback only: the server is offline-mode with the bot names opped, so anyone who can
      // reach it can join as BuilderBot with operator. Docker-published ports bypass host
      // firewalls. MC_BIND=0.0.0.0 to expose it deliberately (then server:recreate).
      `-p ${process.env.MC_BIND || '127.0.0.1'}:${PORT}:25565`,
      '-e EULA=TRUE -e ONLINE_MODE=FALSE -e ENABLE_COMMAND_BLOCK=TRUE',
      // Raised superflat - no caverns anywhere (see GENERATOR_SETTINGS above).
      `-e LEVEL_TYPE=FLAT -e 'GENERATOR_SETTINGS=${GENERATOR_SETTINGS}'`,
      // 1.20.1: must match the bots (src/bot.js) AND be exactly supported by
      // prismarine-viewer so the browser view renders blocks correctly.
      `-e VERSION=${process.env.MC_VERSION || '1.20.1'} -e MEMORY=${process.env.MC_MEMORY || '2G'}`,
      // How much world the server STREAMS to each bot, in chunks. The default (10, ~160
      // blocks) is smaller than the scene the web panel paints: that platform is 337x337
      // (see plotBounds in scripts/web.js), so from the camera bot parked at the build site
      // the far half of it was never sent at all - which is the hard edge where the grass
      // stops and the sky begins in the browser view. 24 chunks = 384 blocks reaches the
      // far corners. This is also the ceiling on VIEWER_DISTANCE (src/viewer.js): the
      // browser renders the bot's world, and it cannot draw chunks the server never sent.
      `-e VIEW_DISTANCE=${process.env.MC_VIEW_DISTANCE || '24'}`,
      `-v ${VOLUME}:/data`,
      `-v "${opsMount}"`,
      IMAGE,
    ].join(' '));
  }

  const ready = await waitUntilReady();
  if (!ready) {
    console.error(r(`\n✖ Server didn't become ready in time.`));
    console.error(`  Check the logs:  docker logs ${NAME}\n`);
    process.exit(1);
  }
  console.log(g(`✔ Server ready on port ${PORT}`));
}

function stopServer() {
  requireDocker();
  if (containerState() === 'missing') { console.log('• No server container to stop.'); return; }
  quiet(`docker stop ${NAME}`);
  console.log(g('✔ Server stopped (world kept - `npm run play` starts it again).'));
}

function resetServer() {
  requireDocker();
  quiet(`docker rm -f ${NAME}`);
  quiet(`docker volume rm ${VOLUME}`);
  console.log(g('✔ Server and world removed. Next `npm run play` starts fresh.'));
}

// Rebuild the CONTAINER, keep the WORLD.
//
// Docker only reads `-e` at `docker run`, so a setting like VIEW_DISTANCE is baked into the
// container the day it is created - `docker stop && docker start` replays the ORIGINAL env
// and quietly ignores whatever ensureServerUp would pass today. Changing a server setting
// therefore requires destroying the container, and the only command that did that was
// `reset`, which also drops the world volume. So a settings change cost you every build you
// had standing. It doesn't now: the world lives in the named volume, not the container.
async function recreateServer() {
  requireDocker();
  quiet(`docker rm -f ${NAME}`);
  console.log('• Container removed (world volume kept) - recreating with current settings...');
  await ensureServerUp();
}

async function status() {
  requireDocker();
  const state = containerState();
  const open = state === 'running' ? await portOpen() : false;
  console.log(`container: ${state}   port ${PORT}: ${open ? g('open') : r('closed')}`);
}

// CLI - only parse argv and dispatch when invoked directly (`node scripts/server.js`),
// NOT when imported by play.js (whose argv is the build prompt/flags, not a server command).
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] || 'up';
  const run = { up: ensureServerUp, stop: stopServer, reset: resetServer, recreate: recreateServer, status };
  if (!run[cmd]) { console.error(`Unknown command: ${cmd}. Use: up | stop | reset | recreate | status`); process.exit(1); }
  await run[cmd]();
}
