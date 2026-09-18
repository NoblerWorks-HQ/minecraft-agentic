// The build ops - the vocabulary the model designs in (src/ops.js).
//
// Two things are being pinned here, and they are different in kind.
//
// 1. THE PRIMITIVES DO WHAT THEY CLAIM. The whole reason ops exist is that a model hand-typing
//    a wall leaves holes in it (our critic scored one such build 3/10 and was right). If a
//    `walls` op can produce a gappy wall, the cure is worse than the disease - so a wall is
//    asserted to be a complete, solid perimeter, and a door to be two halves.
//
// 2. EVERY OP IS UNTRUSTED INPUT. `expandOps` is the only door between a model's JSON and the
//    world, exactly like normalizePatch in repair.js. One unvalidated `box` with a hallucinated
//    bound fills the map; one hallucinated block name ("stone_brick", singular) is discarded by
//    the server WITHOUT A WORD, leaving a hole in the build that nothing in the logs explains.
//
// No server, no browser, no API key.
import { readFileSync } from 'node:fs';
import { expandOps, planFromOps, normalizeType, opsReference, OPS, LIMITS } from '../src/ops.js';
import { toPlan } from '../src/coordinator.js';

let failed = 0;
const pass = (cond, label, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!cond) failed++;
};
const quiet = { log: () => {} };
const blocksOf = (canvas) => Object.values(canvas.roles).flat();
const at = (blocks, x, y, z) => blocks.find((b) => b.x === x && b.y === y && b.z === z);

// --- the primitives are solid by construction ---------------------------------------------
{
  const { canvas } = expandOps([
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, z1: 5, y0: 0, y1: 3, type: 'stone_bricks' },
  ]);
  const b = blocksOf(canvas);
  // a 6x6 perimeter is 20 blocks per layer, 4 layers high, and EVERY cell present
  let holes = 0;
  for (let y = 0; y <= 3; y++)
    for (let x = 0; x <= 5; x++)
      for (let z = 0; z <= 5; z++)
        if ((x === 0 || x === 5 || z === 0 || z === 5) && !at(b, x, y, z)) holes++;
  pass(b.length === 80 && holes === 0, 'a `walls` op is a SOLID perimeter - the thing the model could not hand-type', { blocks: b.length, holes });
}
{
  // punch carves the opening OUT of the wall-builder's own list, so exactly one role owns it
  const { canvas } = expandOps([
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, z1: 5, y0: 0, y1: 3, type: 'stone_bricks' },
    { op: 'punch', role: 'mason', x0: 2, y0: 1, z0: 0, x1: 3, y1: 2, z1: 0 },
    { op: 'box', role: 'decorator', x0: 2, y0: 1, z0: 0, x1: 3, y1: 2, z1: 0, type: 'glass_pane' },
  ]);
  const mason = canvas.roles.mason, dec = canvas.roles.decorator;
  const masonOwns = mason.some((b) => b.x === 2 && b.y === 1 && b.z === 0);
  pass(!masonOwns && dec.length === 4,
    'a `punch` REMOVES from the wall it owns, so the glazing that follows is not buried by it', { masonStillOwnsHole: masonOwns, panes: dec.length });
}
{
  // The window op exists because when glazing was TWO ops (punch the wall, then place the
  // glass) the model had to make two sets of coordinates agree - and when they did not, it hung
  // a pane of glass in mid-air outside the building. Seen live 2026-07-14; the critic scored
  // that build 10/10 and never mentioned it. One op, so they cannot disagree.
  const { canvas } = expandOps([
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, z1: 5, y0: 0, y1: 3, type: 'stone_bricks' },
    { op: 'window', role: 'mason', x0: 2, y0: 1, z0: 0, x1: 3, y1: 2, z1: 0, type: 'glass_pane' },
  ]);
  const glazed = canvas.roles.decorator;
  const wallGone = !canvas.roles.mason.some((b) => b.x === 2 && b.y === 1 && b.z === 0);
  pass(glazed.length === 4 && glazed.every((b) => b.type === 'glass_pane') && wallGone,
    'a `window` op carves the hole AND glazes it in one move - they cannot disagree', { panes: glazed.length });
}
{
  const { canvas, dropped } = expandOps([
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, z1: 5, y0: 0, y1: 3, type: 'stone_bricks' },
    { op: 'window', role: 'mason', x0: 20, y0: 1, z0: 20, x1: 21, y1: 2, z1: 20, type: 'glass_pane' },
  ]);
  pass(canvas.roles.decorator.length === 0 && /nothing to glaze/.test(dropped[0]?.why || ''),
    'and a window aimed at THIN AIR glazes nothing - the floating pane of glass is now impossible', dropped[0]);
}
{
  // Live 2026-07-30: the model wrote windows as a plane and left out "z1", and each one was
  // dropped. A window's missing second bound now defaults to its first.
  const { canvas, dropped } = expandOps([
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, z1: 5, y0: 0, y1: 3, type: 'stone_bricks' },
    { op: 'window', role: 'mason', x0: 2, y0: 1, z0: 0, x1: 3, y1: 2, type: 'glass_pane' },
  ]);
  pass(canvas.roles.decorator.length === 4 && dropped.length === 0,
    'a `window` that omits z1 is read as a plane at z0, not dropped', { panes: canvas.roles.decorator.length, dropped });
}
{
  const { dropped } = expandOps([{ op: 'box', role: 'mason', x0: 0, y0: 0, z0: 0, x1: 3, y1: 3, type: 'stone_bricks' }]);
  pass(/missing or non-numeric "z1"/.test(dropped[0]?.why || ''),
    'but a `box` with a missing bound is still dropped - the default is window-only', dropped[0]);
}
{
  const { canvas } = expandOps([{ op: 'door', role: 'carpenter', x: 3, y: 1, z: 0, type: 'oak_door', facing: 'north' }]);
  const b = blocksOf(canvas);
  pass(b.length === 2 && /half=lower/.test(b[0].type) && /half=upper/.test(b[1].type) && b[1].y === 2,
    'a `door` op places BOTH halves - a lone lower half is an invalid state the game deletes', b.map((k) => k.type));
}
{
  const { canvas } = expandOps([{ op: 'cone', role: 'carpenter', cx: 5, cz: 5, r0: 4, y0: 10, type: 'spruce_stairs' }]);
  const stairs = blocksOf(canvas).filter((b) => /_stairs/.test(b.type));
  pass(stairs.length > 0 && stairs.every((b) => /facing=/.test(b.type)),
    'a `cone` op orients its own shingles - unfaced stairs all point north and read as a broken roof', { stairs: stairs.length });
}

// --- untrusted input: the model cannot escape the plot, the budget, or the block registry ---
{
  const { dropped } = expandOps([{ op: 'obliterate', role: 'mason', x: 1, y: 1, z: 1, type: 'tnt' }]);
  pass(dropped.length === 1 && dropped[0].why === 'unknown op', 'an unknown op is dropped, not guessed at', dropped[0]);
}
{
  const { canvas } = expandOps([{ op: 'put', role: 'stonemason', x: 1, y: 1, z: 1, type: 'stone' }]);
  pass(canvas.roles.mason.length === 1,
    'an unknown ROLE is coerced (losing a whole wall over a job title would be worse than mislabelling it)');
}
{
  const { dropped, canvas } = expandOps([{ op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, y0: 0, y1: 3, type: 'stone' }]);
  pass(blocksOf(canvas).length === 0 && /z1/.test(dropped[0]?.why),
    'a shape with a MISSING bound is dropped, never guessed - a guessed bound is how a box eats the plot', dropped[0]);
}
{
  const { canvas } = expandOps([{ op: 'box', role: 'mason', x0: -900, y0: -900, z0: -900, x1: -880, y1: -880, z1: -880, type: 'stone' }]);
  const b = blocksOf(canvas);
  const inside = b.every((k) => k.x >= LIMITS.minXZ && k.x <= LIMITS.maxXZ && k.y >= LIMITS.minY && k.z >= LIMITS.minXZ);
  pass(inside, 'coordinates far outside the plot are CLAMPED into it, never sent to the neighbouring build', { blocks: b.length });
}
{
  // the runaway: a box the size of the world. Clamping alone would still yield ~48*52*48.
  const { dropped, canvas } = expandOps([{ op: 'box', role: 'mason', x0: -8, y0: -4, z0: -8, x1: 39, y1: 48, z1: 39, type: 'stone' }]);
  pass(blocksOf(canvas).length === 0 && /refused/.test(dropped[0]?.why || ''),
    'a single runaway op is REFUSED outright - clamping its bounds would still have filled the plot solid', dropped[0]);
}
{
  const many = Array.from({ length: 40 }, (_, i) => ({ op: 'box', role: 'mason', x0: 0, y0: 0, z0: 0, x1: 11, y1: 11, z1: 11, type: 'stone', _i: i }));
  const { blocks, dropped } = expandOps(many);
  pass(blocks <= LIMITS.maxBlocks && dropped.some((d) => /ceiling/.test(d.why)),
    `the total block budget is a hard ceiling (${LIMITS.maxBlocks}), and hitting it is REPORTED, not silently truncated`, { blocks });
}

// --- the block registry: the quietest failure in the project -------------------------------
pass(normalizeType('minecraft:stone_bricks') === 'stone_bricks', 'a minecraft: prefix is stripped');
pass(normalizeType('stone_brick') === 'stone_bricks', 'a singular/plural slip is REPAIRED rather than lost (stone_brick -> stone_bricks)');
pass(normalizeType('oak_stairs[facing=north]') === 'oak_stairs[facing=north]', 'a block STATE survives normalization');
pass(normalizeType('wooden_plank') === null, 'a hallucinated block name is DROPPED - /setblock would discard it silently and leave an unexplained hole');
pass(normalizeType('') === null && normalizeType(null) === null, 'an empty type is dropped');
{
  const { dropped } = expandOps([{ op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 5, z1: 5, y0: 0, y1: 3, type: 'castle_wall' }]);
  pass(/unknown block type/.test(dropped[0]?.why || ''), 'and the drop says WHY, naming the block the model invented', dropped[0]);
}

// --- the prompt cannot drift from the code -------------------------------------------------
{
  const ref = opsReference();
  const missing = Object.keys(OPS).filter((name) => !ref.includes(`"op": "${name}"`) && name !== 'punch');
  pass(missing.length === 0 && ref.includes('punch'),
    'the op reference shown to the model is GENERATED from the OPS table - it cannot describe an op that does not exist, or miss one that does', { missing });
}

// --- a raw block list is validated too, not waved through -----------------------------------
{
  const plan = toPlan({
    name: 'Legacy', assignments: {
      mason: { task: 'walls', blocks: [{ x: 1, y: 0, z: 1, type: 'minecraft:stone_brick' }, { x: 2, y: 0, z: 2, type: 'wooden_plank' }] },
    },
  }, 'a hut');
  const b = Object.values(plan.assignments).flatMap((a) => a.blocks);
  pass(b.length === 1 && b[0].type === 'stone_bricks',
    'a model that ignores the ops format and returns raw BLOCKS is routed through the same door: the bad name is dropped, the fixable one repaired', b);
}

// --- the worked example is the most-copied build in the project ------------------------------
{
  const spec = JSON.parse(readFileSync(new URL('../src/plans/reference-ops.json', import.meta.url), 'utf8'));
  const plan = planFromOps(spec, quiet);
  const b = Object.values(plan.assignments).flatMap((a) => a.blocks);
  const roles = Object.entries(plan.assignments).filter(([, a]) => a.blocks.length > 0).map(([r]) => r);
  const tall = Math.max(...b.map((k) => k.y)) - Math.min(...b.map((k) => k.y));
  // It is shown to the model on EVERY request, so if it ever degrades, every AI build degrades
  // with it. It is also audited on the real parallel schedule in preset-audit.test.mjs.
  pass(b.length > 800, 'the worked example is preset-scale - it is what the model is imitating', { blocks: b.length });
  pass(roles.length === 4, 'and it gives all four roles real work', roles);
  pass(tall >= 15, 'and it has presence (a tiny hut teaches the model to build tiny huts)', { height: tall });
  pass(spec.ops.length < 40, 'and it does it in a handful of ops - which is the entire point', { ops: spec.ops.length });
}

// --- decorator puts need something to hang on (the window treatment, for all decoration) -----
{
  const wall = { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 6, z1: 6, y0: 0, y1: 4, type: 'stone_bricks' };
  const { canvas, dropped, applied } = expandOps([
    wall,
    { op: 'put', role: 'decorator', x: 3, y: 3, z: -1, type: 'lantern' },      // on the wall face: kept
    { op: 'put', role: 'decorator', x: 3, y: 6, z: -4, type: 'lantern' },      // mid-air: dropped
    { op: 'put', role: 'decorator', x: 12, y: 0, z: 12, type: 'lantern' },     // on the ground: kept
    { op: 'put', role: 'decorator', x: 3, y: 5, z: 3, type: 'glass' },         // resting on nothing: dropped
  ]);
  const dec = canvas.roles.decorator;
  pass(!!at(dec, 3, 3, -1), 'a decorator put touching a wall face is kept');
  pass(!!at(dec, 12, 0, 12), 'a decorator put standing on the ground (y = 0) is kept');
  pass(!at(dec, 3, 6, -4), 'a decorator put floating in mid-air is dropped');
  pass(!at(dec, 3, 5, 3), 'a pane hovering over the empty middle of the plot is dropped');
  const floats = dropped.filter((d) => d.op === 'put');
  pass(floats.length === 2 && floats.every((d) => /would float/.test(d.why)), 'and each drop is reported, never silent', floats);
  pass(applied === 3, 'dropped puts do not count as applied', { applied });
}
{
  // Order-independent: a put listed BEFORE the wall it hangs on is judged against the finished canvas.
  const { canvas, dropped } = expandOps([
    { op: 'put', role: 'decorator', x: 3, y: 3, z: -1, type: 'lantern' },
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 6, z1: 6, y0: 0, y1: 4, type: 'stone_bricks' },
  ]);
  pass(!!at(canvas.roles.decorator, 3, 3, -1) && dropped.length === 0, 'a put listed before its wall is still kept', dropped);
}
{
  // A chain of puts hanging from a beam is supported link by link.
  const { canvas, dropped } = expandOps([
    { op: 'floor', role: 'carpenter', x0: 0, z0: 0, x1: 4, z1: 4, y: 8, type: 'oak_planks' },
    { op: 'put', role: 'decorator', x: 2, y: 6, z: 2, type: 'lantern' },   // listed first, hangs off the chain
    { op: 'put', role: 'decorator', x: 2, y: 7, z: 2, type: 'chain' },     // hangs off the floor
  ]);
  pass(!!at(canvas.roles.decorator, 2, 6, 2) && !!at(canvas.roles.decorator, 2, 7, 2) && dropped.length === 0,
    'a lantern on a chain under a beam is kept (support propagates through other puts)', dropped);
}
{
  // Only the decorator's puts are checked; other roles' puts and the window glazing are untouched.
  const { canvas, dropped } = expandOps([
    { op: 'walls', role: 'mason', x0: 0, z0: 0, x1: 6, z1: 6, y0: 0, y1: 4, type: 'stone_bricks' },
    { op: 'window', role: 'mason', x0: 2, y0: 2, z0: 0, x1: 3, y1: 3, z1: 0, type: 'glass_pane' },
    { op: 'put', role: 'carpenter', x: 20, y: 9, z: 20, type: 'oak_planks' },
  ]);
  pass(!!at(canvas.roles.carpenter, 20, 9, 20), "another role's put is not support-checked");
  pass(canvas.roles.decorator.length === 4 && dropped.length === 0, 'window glazing is not treated as a floating put', { glass: canvas.roles.decorator.length, dropped });
}
{
  const spec = JSON.parse(readFileSync(new URL('../src/plans/reference-ops.json', import.meta.url), 'utf8'));
  const { dropped } = expandOps(spec.ops);
  pass(!dropped.some((d) => /would float/.test(d.why)), 'the worked example the model imitates has no floating decoration', dropped);
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll ops checks passed.');
process.exit(failed ? 1 : 0);
