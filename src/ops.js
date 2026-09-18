// THE BUILD OPS - the vocabulary the model designs in.
//
// Why this exists. The presets were not better than the AI builds because a human designed
// them; they were better because a human gave them PRIMITIVES. A preset says `walls(...)` and
// gets 400 gap-free blocks. The model used to be asked for the same wall as a JSON array with
// one object per block - {"x":12,"y":7,"z":3,"type":"stone_bricks"}, about 11 tokens each. A
// 900-block build is then ~10k tokens of pure mechanical enumeration, and the castle (3,338
// blocks) is ~38k, which no output budget we could set would buy. So the model shortcut, the
// way anyone would: it returned 74 blocks with holes in the walls, and our own critic scored
// it 3/10 and was right.
//
// An op is 1 line and expands to hundreds of blocks - a 20-40x compression - so the model can
// finally afford the scale we ask it for, and spends its budget on DESIGN instead of typing.
// It also cannot make the old mistakes: a `walls` op is gap-free by construction, a `door` op
// always places both halves, a `cone` op orients its stair shingles, and an opening is a
// `punch` (which REMOVES from the wall-builder's own list) rather than a pane written over a
// wall coordinate, which the parallel build race would bury.
//
// EVERY OP IS UNTRUSTED INPUT. `expandOps` is the only door, and it is the same job
// normalizePatch does in repair.js: coerce what is coercible, drop what is not, and never
// trust a coordinate, a role, a radius or a block name. A single unvalidated `box` op with a
// hallucinated bound would fill the map.
import mcData from 'minecraft-data';
import { makeCanvas, finalize, ROLES, ROLE_TASKS } from './library/canvas.js';

// Limits, all grounded in what the hand-built presets actually do (measured: they span
// x -5..31, y -2..31, z -6..29, and the largest is ~3,200 blocks). A build lives in one 40x40
// cell of the panel's grid, so a coordinate outside these bounds is not an ambitious build -
// it is a model error that would spill into the neighbouring plot.
export const LIMITS = {
  minXZ: -8, maxXZ: 39,     // the build cell, with the margin levelSite() clears
  minY: -4, maxY: 48,       // -4 lets a foundation sink in; 48 is far above the tallest preset
  maxRadius: 24,
  maxBlocksPerOp: 2400,     // a single op bigger than this is a runaway, not a design
  maxBlocks: 4000,          // total, just above the biggest preset (castle ~3,300)
  maxOps: 400,
};

// The op vocabulary. `args` is the ordered list of numeric params; the prompt in
// coordinator.js is GENERATED from this table, so the model can never be told about an op
// that does not exist, or miss one that does.
export const OPS = {
  box:   { args: ['x0', 'y0', 'z0', 'x1', 'y1', 'z1'], type: true, doc: 'solid filled box, corner to corner (inclusive)' },
  walls: { args: ['x0', 'z0', 'x1', 'z1', 'y0', 'y1'], type: true, doc: 'the four vertical walls of a rectangle, y0..y1 - hollow inside, never gappy' },
  floor: { args: ['x0', 'z0', 'x1', 'z1', 'y'], type: true, doc: 'a flat rectangular slab at height y (floors, ceilings, terraces)' },
  cyl:   { args: ['cx', 'cz', 'r', 'y0', 'y1'], type: true, doc: 'a hollow round tower wall, radius r, y0..y1 (gap-free circle)' },
  disc:  { args: ['cx', 'cz', 'r', 'y'], type: true, doc: 'a solid filled circle at height y (a round floor or roof)' },
  ring:  { args: ['cx', 'cz', 'r', 'y'], type: true, doc: 'a single circular outline at height y (a balcony rail, a crown)' },
  cone:  { args: ['cx', 'cz', 'r0', 'y0'], type: true, doc: 'a stepped spire from radius r0 at y0 up to a point. Use a *_stairs type and the shingles orient themselves' },
  door:  { args: ['x', 'y', 'z'], type: true, facing: true, doc: 'a door - places BOTH halves. Needs a solid block below it, from an earlier role' },
  put:   { args: ['x', 'y', 'z'], type: true, doc: 'one single block (a torch, a lantern, a detail)' },
  punch: { args: [], type: false, doc: 'CARVE AN OPENING (a doorway, an arch): removes blocks from this role\'s own list. Give pts [[x,y,z],...] or a box x0,y0,z0,x1,y1,z1' },
  window: { args: ['x0', 'y0', 'z0', 'x1', 'y1', 'z1'], type: true, doc: 'A GLAZED WINDOW, in one op: punches the hole out of THIS role\'s wall and fills it with glass. Use this for every window - do not punch and glaze separately' },
  scatter: { args: ['x0', 'z0', 'x1', 'z1', 'y'], type: true, density: true, doc: 'sprinkle a block randomly over a rectangle at height y (grass, flowers). density 0..1' },
};

let _names = null;
/** Every block name the 1.20.1 server will actually accept. */
function blockNames() {
  if (!_names) _names = new Set(mcData('1.20.1').blocksArray.map((b) => b.name));
  return _names;
}

/**
 * Coerce a model's block name into one the server accepts, or return null.
 *
 * A bad name is the quietest failure in the whole project: `/setblock x y z minecraft:stone_brick`
 * (singular) is discarded by the server without a word, so the block simply never appears and
 * the build comes out full of holes that nothing explains. Models reach for the singular, the
 * plural, and the odd invented compound, so a near-miss is REPAIRED (stone_brick ->
 * stone_bricks) rather than dropped - but anything we cannot resolve is dropped here, loudly,
 * instead of being sent to a server that will ignore it silently.
 */
export function normalizeType(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let t = raw.trim().toLowerCase().replace(/^minecraft:/, '');
  const m = t.match(/^([a-z0-9_]+)(\[.*\])?$/);
  if (!m) return null;
  let [, base, state = ''] = m;
  const names = blockNames();
  if (!names.has(base)) {
    // plural/singular slips are the common model error - fix them rather than lose the block
    const tries = [`${base}s`, base.replace(/s$/, ''), base.replace(/_block$/, ''), `${base}_block`];
    const fixed = tries.find((c) => names.has(c));
    if (!fixed) return null;
    base = fixed;
  }
  return `${base}${state}`;
}

const int = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.round(n) : null;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const clampXZ = (n) => clamp(n, LIMITS.minXZ, LIMITS.maxXZ);
const clampY = (n) => clamp(n, LIMITS.minY, LIMITS.maxY);

// How many blocks will this op emit? Used to refuse a runaway before it is expanded.
function opCost(name, a) {
  const dx = Math.abs(a.x1 - a.x0) + 1, dy = Math.abs(a.y1 - a.y0) + 1, dz = Math.abs(a.z1 - a.z0) + 1;
  switch (name) {
    case 'box': return dx * dy * dz;
    case 'walls': return 2 * (dx + dz) * (Math.abs(a.y1 - a.y0) + 1);
    case 'floor': case 'scatter': return dx * dz;
    case 'cyl': return 8 * a.r * (Math.abs(a.y1 - a.y0) + 1);
    case 'disc': return Math.ceil(Math.PI * a.r * a.r);
    case 'ring': return 8 * a.r;
    case 'cone': return Math.ceil(Math.PI * a.r0 * a.r0);
    case 'door': return 2;
    default: return 1;
  }
}

/**
 * Expand a model's op list into per-role block lists, dropping anything unsafe.
 *
 * Ops are applied IN ORDER within a role, which is what makes `punch` work: walls first, then
 * the opening carved out of them.
 *
 * @returns {{canvas: object, dropped: Array<{op: string, why: string}>, applied: number, blocks: number}}
 */
export function expandOps(ops, { limits = LIMITS } = {}) {
  const canvas = makeCanvas();
  const dropped = [];
  let applied = 0;
  let total = 0;

  const list = Array.isArray(ops) ? ops.slice(0, limits.maxOps) : [];
  if (Array.isArray(ops) && ops.length > limits.maxOps) {
    dropped.push({ op: 'ops', why: `only the first ${limits.maxOps} ops were kept (got ${ops.length})` });
  }

  for (const raw of list) {
    const name = String(raw?.op || '').toLowerCase().trim();
    const spec = OPS[name];
    if (!spec) { dropped.push({ op: name || '(none)', why: 'unknown op' }); continue; }

    // An unknown role is coerced, not dropped: the geometry is usually right and the model
    // just said "builder" or "stonemason". Losing a whole wall over a label would be worse.
    const role = ROLES.includes(raw.role) ? raw.role : 'mason';

    // Numeric params. Missing/NaN is fatal for that op - a wall with no x1 is not repairable,
    // and guessing a bound is how you get a box that fills the plot.
    const a = {};
    let bad = null;
    // A window is a flat rectangle, and a model writing one reasonably gives three coords and a
    // plane - two of the watchtower's windows were dropped live for a missing "z1". For `window`
    // (and only `window`) a missing second bound defaults to its first: unambiguous for a plane,
    // and it cannot run away the way a guessed `box` bound fills the plot.
    const src = name === 'window' ? { ...raw } : raw;
    if (name === 'window') {
      for (const ax of ['x', 'y', 'z']) {
        if (int(src[`${ax}1`]) === null && int(src[`${ax}0`]) !== null) src[`${ax}1`] = src[`${ax}0`];
      }
    }
    for (const k of spec.args) {
      const v = int(src[k]);
      if (v === null) { bad = `missing or non-numeric "${k}"`; break; }
      a[k] = /^(y|y0|y1)$/.test(k) ? clampY(v) : /^r/.test(k) ? clamp(v, 1, limits.maxRadius) : clampXZ(v);
    }
    if (bad) { dropped.push({ op: name, why: bad }); continue; }

    let type = null;
    if (spec.type) {
      type = normalizeType(raw.type);
      if (!type) { dropped.push({ op: name, why: `unknown block type "${raw.type}"` }); continue; }
    }

    // punch takes coordinates, not a shape - handle it before the cost check.
    if (name === 'punch') {
      const pts = punchPoints(raw, limits);
      if (!pts.length) { dropped.push({ op: 'punch', why: 'no valid pts or box given' }); continue; }
      const removed = canvas.punch(role, pts);
      if (!removed.length) dropped.push({ op: 'punch', why: `punched nothing - ${role} has no wall at those coordinates` });
      applied++;
      continue;
    }

    // A window is ONE op on purpose. When it was two - punch the wall, then glaze the hole -
    // the model had to make two sets of coordinates agree, and when they did not it produced a
    // pane of glass hanging in mid-air OUTSIDE the building (seen live, 2026-07-14; the critic
    // gave that build 10/10 and never mentioned it). Now the hole and the glass are the same
    // coordinates by construction, and the glass goes ONLY where a wall was really removed, so
    // a window aimed at thin air is a no-op instead of a floating cube. The glazing is the
    // decorator's, so exactly one role ends up owning the coordinate.
    if (name === 'window') {
      const removed = canvas.punch(role, punchPoints(src, limits));
      if (!removed.length) {
        dropped.push({ op: 'window', why: `no ${role} wall at those coordinates - nothing to glaze` });
        continue;
      }
      for (const [x, y, z] of removed) canvas.put('decorator', x, y, z, type);
      applied++;
      total += removed.length;
      continue;
    }

    const cost = opCost(name, a);
    if (cost > limits.maxBlocksPerOp) {
      dropped.push({ op: name, why: `would place ${cost} blocks (limit ${limits.maxBlocksPerOp}) - refused` });
      continue;
    }
    if (total + cost > limits.maxBlocks) {
      dropped.push({ op: name, why: `build is already at the ${limits.maxBlocks}-block ceiling` });
      continue;
    }

    switch (name) {
      case 'box': canvas.box(role, a.x0, a.y0, a.z0, a.x1, a.y1, a.z1, type); break;
      case 'walls': canvas.walls(role, a.x0, a.z0, a.x1, a.z1, a.y0, a.y1, type); break;
      case 'floor': canvas.floor(role, a.x0, a.z0, a.x1, a.z1, a.y, type); break;
      case 'cyl': canvas.cyl(role, a.cx, a.cz, a.r, a.y0, a.y1, type); break;
      case 'disc': canvas.disc(role, a.cx, a.cz, a.r, a.y, type); break;
      case 'ring': canvas.ring(role, a.cx, a.cz, a.r, a.y, type); break;
      case 'cone': canvas.cone(role, a.cx, a.cz, a.r0, a.y0, type); break;
      case 'put': canvas.put(role, a.x, a.y, a.z, type); break;
      case 'door': {
        const facing = ['north', 'south', 'east', 'west'].includes(raw.facing) ? raw.facing : 'north';
        canvas.door(role, a.x, a.y, a.z, type.split('[')[0], facing);
        break;
      }
      case 'scatter': {
        const d = Number.isFinite(Number(raw.density)) ? clamp(Number(raw.density), 0.01, 1) : 0.25;
        for (let x = Math.min(a.x0, a.x1); x <= Math.max(a.x0, a.x1); x++)
          for (let z = Math.min(a.z0, a.z1); z <= Math.max(a.z0, a.z1); z++)
            if (Math.random() < d) canvas.put(role, x, a.y, z, type);
        break;
      }
      default: break;
    }
    applied++;
    total += cost;
  }

  const blocks = ROLES.reduce((s, r) => s + canvas.roles[r].length, 0);
  return { canvas, dropped, applied, blocks };
}

/** punch accepts either an explicit point list or a box region (a window is a rectangle). */
function punchPoints(raw, limits) {
  const pts = [];
  if (Array.isArray(raw.pts)) {
    for (const p of raw.pts) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const [x, y, z] = p.map(int);
      if (x === null || y === null || z === null) continue;
      pts.push([clampXZ(x), clampY(y), clampXZ(z)]);
    }
  }
  const has = (k) => int(raw[k]) !== null;
  if (['x0', 'y0', 'z0', 'x1', 'y1', 'z1'].every(has)) {
    const x0 = clampXZ(int(raw.x0)), x1 = clampXZ(int(raw.x1));
    const y0 = clampY(int(raw.y0)), y1 = clampY(int(raw.y1));
    const z0 = clampXZ(int(raw.z0)), z1 = clampXZ(int(raw.z1));
    let n = 0;
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
          if (++n > limits.maxBlocksPerOp) return pts;
          pts.push([x, y, z]);
        }
  }
  return pts;
}

/**
 * Turn a model's op-format plan into a crew-format plan (per-role block lists), through the
 * exact same `finalize()` the library presets use - so an AI build and a preset are, from the
 * crew's point of view, indistinguishable.
 */
export function planFromOps(spec, { log = console.log } = {}) {
  const { canvas, dropped, applied, blocks } = expandOps(spec.ops);

  const tasks = {};
  for (const role of ROLES) {
    const t = spec.tasks?.[role];
    tasks[role] = typeof t === 'string' && t.trim() ? t.trim() : ROLE_TASKS[role];
  }

  const plan = finalize(
    String(spec.name || 'Untitled Build').slice(0, 80),
    String(spec.description || '').slice(0, 300),
    canvas,
    Array.isArray(spec.teamChat) ? spec.teamChat.slice(0, 6) : [],
    tasks,
  );

  // Never silently truncate: if we refused a third of the model's design, say so.
  if (dropped.length) {
    log(`[Ops] ${applied} ops expanded to ${blocks} blocks; ${dropped.length} op(s) dropped:`);
    for (const d of dropped.slice(0, 8)) log(`   - ${d.op}: ${d.why}`);
  } else {
    log(`[Ops] ${applied} ops expanded to ${blocks} blocks.`);
  }
  plan.ops = { applied, dropped };
  return plan;
}

/**
 * The op reference, rendered for the prompt straight from the OPS table above - so the model
 * is never told about an op that does not exist, and never misses one that does.
 */
export function opsReference() {
  const lines = Object.entries(OPS).map(([name, spec]) => {
    const args = [...spec.args.map((a) => `"${a}": <int>`)];
    if (spec.type) args.push('"type": "<block>"');
    if (spec.facing) args.push('"facing": "north|south|east|west"');
    if (spec.density) args.push('"density": <0..1>');
    const shape = name === 'punch'
      ? '{ "op": "punch", "role": "<role>", "pts": [[x,y,z], ...] }   OR   { "op": "punch", "role": "<role>", "x0":.., "y0":.., "z0":.., "x1":.., "y1":.., "z1":.. }'
      : `{ "op": "${name}", "role": "<role>", ${args.join(', ')} }`;
    return `  ${shape}\n      ${spec.doc}`;
  });
  return lines.join('\n');
}
