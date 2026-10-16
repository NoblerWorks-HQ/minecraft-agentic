// The two self-correction loops, and the crew-as-data that feeds them (`npm run test:loops`).
//
// Everything covered here is pure: no server, no browser, no API key. What it pins down is the
// stuff that would otherwise fail SILENTLY in a live build - the failure mode this whole repo
// keeps being bitten by. Specifically:
//
//   - a patch from a model is untrusted input, and a malformed entry goes out as
//     `/setblock x y z minecraft:undefined`, which the server drops without a word;
//   - a patch's coordinates are RELATIVE and the world's are ABSOLUTE, and getting that
//     backwards lands the fix in a neighbouring plot with nothing to show for it;
//   - the roles' build order lives in two places now (the profiles and the library's plans) and
//     if they ever disagree the build timeline breaks - support after supported.
//
// Run after touching src/profiles/, src/digest.js, src/repair.js or src/critic.js.

import { buildRoles, allProfiles, teamBrief, profile } from '../src/profiles.js';
import { planDigest } from '../src/digest.js';
import { normalizePatch, applyPatch, expectedBlocks, missingBlocks, POPS_OFF } from '../src/repair.js';
import { pickExample } from '../src/coordinator.js';
import { getLibraryPlan } from '../src/library/index.js';
import { geminiModelIsUnavailable, GEMINI_FALLBACKS, extractClaudeText, extractOpenAIText, openaiTokenParams } from '../src/providers.js';
import { fillPlan, FILL_CAP } from '../src/fill.js';
import { parseJsonish } from '../src/json.js';

let failed = 0;
const pass = (ok, name, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- the crew, as data ------------------------------------------------------------
const roles = buildRoles();
pass(eq(roles, ['mason', 'carpenter', 'decorator', 'landscaper']),
  'the four builder roles load from src/profiles/, in build order', JSON.stringify(roles));
pass(!roles.includes('architect') && !!profile('architect'),
  'the architect is a profile but not a builder (it places no blocks)');
pass(allProfiles().every((p) => p.name && p.role && Array.isArray(p.phrases) && p.phrases.length),
  'every profile has the fields worker.js needs (name, role, phrases)');

// The single most important thing about the profiles: their order IS the build timeline. The
// library's plans carry their own hardcoded buildOrder, and if the two ever drift the crew
// builds a role's blocks before the role that supports them - the bug class that ate the
// castle's gate doors. Hold them together.
const lib = getLibraryPlan('castle');
pass(eq(lib.buildOrder, roles),
  "the library's build order matches the profiles' order", `${lib.buildOrder} vs ${roles}`);

const brief = teamBrief();
pass(roles.every((r) => brief.includes(`- ${r}:`)) && brief.includes('stone_bricks'),
  "the coordinator's team prompt is generated from the profiles (roles + materials)");
pass(/load-bearing/i.test(brief) && /hole/i.test(brief),
  'the hard-won rules travel WITH the role into the prompt (load-bearing, openings-are-holes)');

// --- the blueprint ----------------------------------------------------------------
// A tiny plan with a known shape: a 2x2 stone floor at y=0, one plank on top of it, and a
// coordinate written TWICE (stone, then carved back to air) - the case that has to digest to
// what the world actually ends up holding, not to what was written first.
const plan = {
  name: 'Test Hut',
  origin: { x: 100, y: 64, z: 200 },
  buildOrder: ['mason', 'carpenter'],
  assignments: {
    mason: { task: 'floor', blocks: [
      { x: 100, y: 64, z: 200, type: 'stone' },
      { x: 101, y: 64, z: 200, type: 'stone' },
      { x: 100, y: 64, z: 201, type: 'stone' },
      { x: 101, y: 64, z: 201, type: 'stone' },
    ] },
    carpenter: { task: 'post', blocks: [
      { x: 100, y: 65, z: 200, type: 'oak_planks' },
    ] },
  },
};

const digest = planDigest(plan);
pass(digest.includes('Footprint (relative to origin): x 0..1, y 0..1, z 0..1'),
  'the digest reports the footprint in RELATIVE coordinates', digest.split('\n')[1]);
pass(digest.includes('y=0') && digest.includes('y=1'), 'the digest draws one floor map per y layer');
pass(/Legend: .*=stone/.test(digest), 'the digest legends every block type it uses');
// y=1 holds exactly one block, at relative (0,1,0) - the top-left of its map.
const y1 = digest.slice(digest.indexOf('y=1')).split('\n').slice(1, 3).map((l) => l.trim());
pass(y1[0][0] !== '.' && y1[0][1] === '.', 'a block lands in the right cell of its floor map', y1.join('|'));

// --- untrusted patches ------------------------------------------------------------
// Everything a model hands back goes through normalizePatch before it can become a command.
const raw = {
  analysis: 'the post has no support',
  add: [
    { x: 0, y: 1, z: 1, type: 'minecraft:stone_bricks', role: 'mason' },  // namespaced type
    { x: 1, y: 1, z: 1, type: 'oak_planks', role: 'glazier' },            // a role we don't have
    { x: 2, y: 1, z: 1, role: 'mason' },                                  // NO TYPE - the silent killer
    { x: 'a', y: 1, z: 1, type: 'stone', role: 'mason' },                 // junk coordinate
  ],
  remove: [{ x: 0, y: 0, z: 0 }],
};
const patch = normalizePatch(raw, plan);
pass(patch.add.length === 2, 'a patch entry with no block type is DROPPED, not sent as minecraft:undefined',
  `kept ${patch.add.length} of 4`);
pass(patch.add[0].type === 'stone_bricks', 'a namespaced block type is normalized', patch.add[0].type);
pass(patch.add[1].role === 'mason', 'an unknown role falls back to the first builder', patch.add[1].role);

// A patch is exactly as untrusted as an op, so it goes through the same door: a block name is
// checked against the real 1.20.1 registry, and a coordinate is clamped to the plot. Both were
// missing here while expandOps enforced them - and a hallucinated name is the quietest failure
// in the project, because /setblock discards it without a word and the hole stays unexplained.
const hostile = normalizePatch({
  add: [
    { x: 0, y: 2, z: 0, type: 'wooden_plank', role: 'mason' },     // invented - unfixable
    { x: 1, y: 2, z: 0, type: 'stone_brick', role: 'mason' },      // singular slip - repairable
    { x: 500, y: 2, z: -900, type: 'stone', role: 'mason' },       // off the plot entirely
  ],
  remove: [{ x: 4000, y: 900, z: 4000 }],
}, plan);
pass(hostile.add.length === 2,
  'a hallucinated block name is DROPPED - /setblock would discard it in silence',
  `kept ${hostile.add.length} of 3`);
pass(hostile.add[0].type === 'stone_bricks',
  'a singular/plural slip is REPAIRED rather than losing the fix', hostile.add[0].type);
// plan origin is (100,64,200); LIMITS clamp the RELATIVE coords to -8..39 / y -4..48.
pass(hostile.add[1].x === 139 && hostile.add[1].z === 192,
  'a coordinate off the plot is CLAMPED to it - a fix must never land on the neighbouring build',
  JSON.stringify(hostile.add[1]));
pass(hostile.remove[0].x === 139 && hostile.remove[0].y === 112,
  'removals are clamped to the plot too', JSON.stringify(hostile.remove[0]));
pass(eq(patch.add[0], { x: 100, y: 65, z: 201, type: 'stone_bricks', role: 'mason' }),
  'patch coordinates are converted from plan-relative to WORLD-absolute', JSON.stringify(patch.add[0]));
pass(eq(patch.remove[0], { x: 100, y: 64, z: 200, role: 'mason' }),
  'removals are converted to absolute too', JSON.stringify(patch.remove[0]));

// A patch changes the PLAN, not just the world - that's the point of the loop. Voyager improves
// the program, not the output. So the next verify pass must hold the PATCHED plan to account.
const before = expectedBlocks(plan).size;
applyPatch(plan, patch);
const after = expectedBlocks(plan);
pass(!after.has('100,64,200'), 'applyPatch removes the block it was told to remove');
pass(after.get('100,65,201')?.type === 'stone_bricks', 'applyPatch adds the block it was told to add');
pass(after.size === before - 1 + 2, 'the plan grew by the patch, exactly', `${before} -> ${after.size}`);
pass(plan.patches?.[0]?.analysis === 'the post has no support', 'the patch is recorded on the plan');

// --- what "missing" means ----------------------------------------------------------
// The bot's world copy, faked: everything is air except the one stone at 101,64,200.
const fakeBot = {
  blockAt: (v) => ({ name: (v.x === 101 && v.y === 64 && v.z === 200) ? 'stone' : 'air' }),
};
const flowery = {
  origin: { x: 0, y: 0, z: 0 },
  buildOrder: ['mason', 'landscaper'],
  assignments: {
    mason: { blocks: [
      { x: 101, y: 64, z: 200, type: 'stone' },      // in the world
      { x: 105, y: 64, z: 200, type: 'stone_bricks' }, // NOT in the world
    ] },
    landscaper: { blocks: [
      { x: 106, y: 64, z: 200, type: 'poppy' },      // not in the world, but pops off by design
    ] },
  },
};
const gone = missingBlocks(fakeBot, flowery);
pass(gone.length === 1 && gone[0].type === 'stone_bricks',
  'missingBlocks reports structure that never landed', JSON.stringify(gone));
pass(gone[0].role === 'mason', 'a missing block knows which role owns it - that role re-places it');
pass(POPS_OFF.test('poppy') && !POPS_OFF.test('stone_bricks'),
  'a flower that pops off on its own is never counted as a dropped command');

// --- the repair loop's control flow --------------------------------------------------
// A fake crew over a fake world, so the loop can be driven without a server. What matters is
// not that it sends /setblock - it's WHEN IT STOPS. A block the game refuses is refused
// identically every time, so a loop that keeps retrying just burns the build's clock and then
// hands a model a stale failure list.
function fakeCrew({ acceptsReplace }) {
  const world = new Map();                       // "x,y,z" -> block name
  const sent = [];
  const bot = { blockAt: (v) => ({ name: world.get(`${v.x},${v.y},${v.z}`) ?? 'air' }) };
  const worker = {
    alive: true, blocksPlaced: 0, bot: Object.assign(bot, {
      chat: (cmd) => {
        sent.push(cmd);
        const m = cmd.match(/^\/setblock (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/);
        // acceptsReplace=false models the physically-illegal case: the command goes out, the
        // server takes it, and the block still isn't there afterwards.
        if (m && acceptsReplace) world.set(`${m[1]},${m[2]},${m[3]}`, m[4]);
      },
    }),
  };
  return {
    world, sent,
    workers: new Map([['mason', worker], ['carpenter', worker]]),
    activeWorkers: [worker],
    ensureAlive: async () => {},
  };
}
const brokenPlan = () => ({
  name: 'Broken', origin: { x: 0, y: 0, z: 0 }, buildOrder: ['mason'],
  assignments: { mason: { blocks: [
    { x: 1, y: 2, z: 3, type: 'stone' },
    { x: 4, y: 5, z: 6, type: 'oak_planks' },
  ] } },
});

const { repairBuild } = await import('../src/repair.js');
const quiet = () => {};

// Dropped commands: re-placing them works, and one round is enough.
const good = fakeCrew({ acceptsReplace: true });
const r1 = await repairBuild(good, brokenPlan(), { ask: false, log: quiet });
pass(r1.before === 2 && r1.after === 0, 'the repair pass re-places blocks that never landed',
  JSON.stringify(r1));
pass(good.sent.filter((c) => c.startsWith('/setblock')).length === 2,
  'it sends exactly one command per missing block - no retry storm', `${good.sent.length} sent`);
// y-ascending, because a block whose support arrives later is deleted by the game.
const ys = good.sent.map((c) => Number(c.split(' ')[2]));
pass(ys.every((y, i) => i === 0 || ys[i - 1] <= y), 're-placement is y-ascending (support first)', ys.join(','));

// Physically illegal: the world takes the command and the block still isn't there. The loop
// must NOT keep hammering it - one round, no progress, stop.
const bad = fakeCrew({ acceptsReplace: false });
const r2 = await repairBuild(bad, brokenPlan(), { rounds: 4, ask: false, log: quiet });
pass(r2.after === 2, 'a block the game refuses is still reported as missing', JSON.stringify(r2));
pass(bad.sent.filter((c) => c.startsWith('/setblock')).length === 2,
  'the loop STOPS after a round that fixes nothing (it does not retry 4x)',
  `${bad.sent.filter((c) => c.startsWith('/setblock')).length} commands over 4 allowed rounds`);

// --- framing the critic's shot --------------------------------------------------------
// The camera bot's position IS the browser's look-at target, so it has to sit at the middle of
// the build in ALL THREE axes before we photograph it. Both halves of this were found by
// looking at the actual screenshots the critic sent:
//   - parked at the build's ORIGIN (where the crew starts), the tower sat in the corner of an
//     acre of empty grass, half out of frame;
//   - parked at GROUND level, the shot was aimed at the tower's feet and its whole top half,
//     spire included, fell off the top of the frame.
// A model handed either picture critiques the lawn.
const { Crew } = await import('../src/crew.js');
const framed = [];
const crewForFraming = new Crew(null, {});
crewForFraming.camera = { alive: true, park: async (_bot, at) => framed.push(at) };
crewForFraming.activeWorkers = [{ alive: true, bot: {} }];
crewForFraming.sleep = async () => {};
await crewForFraming.frameBuild({
  assignments: { mason: { blocks: [
    { x: 46, y: 71, z: 6, type: 'stone' },     // a 15x33x15 tower, as the library builds one
    { x: 60, y: 103, z: 20, type: 'stone' },
  ] } },
});
pass(eq(framed[0], { x: 53, y: 87, z: 13 }),
  'the critic frames the shot on the build\'s CENTRE, height included', JSON.stringify(framed[0]));

// --- example selection --------------------------------------------------------------
// The coordinator shows the model a matching library build as a worked example (mindcraft's
// per-request example selection, done with word overlap instead of embeddings).
pass(pickExample('a haunted lighthouse on a cliff') === 'lighthouse',
  'the few-shot example matches the request', pickExample('a haunted lighthouse on a cliff'));
pass(pickExample('a windmill by a river') === 'windmill', 'and again');
pass(pickExample('a floating pirate cove') === 'castle',
  'an unmatched request falls back to the castle (it exercises the most timeline rules)');

// --- the Gemini model chain ---------------------------------------------------------
// Google takes free-tier models away without warning, and the failure is per-MODEL, not
// per-key: a build must survive its pinned model going dark by asking the next one. This
// classifier is the whole decision - say "unavailable" too eagerly and a real bug in OUR
// request gets retried three times and reported as Google's fault; say it too rarely and one
// overloaded model takes the product down. Both halves are pinned here.
const dead = [
  ['[GoogleGenerativeAI Error]: Error fetching from https://...: [503 Service Unavailable] This model is currently experiencing high demand.', 'overloaded (503) - what actually happened on 2026-07-14'],
  ['[404 Not Found] models/gemini-2.5-flash is no longer available to new users', 'retired for new keys (404)'],
  ['[429 Too Many Requests] You exceeded your current quota', 'a per-model free quota of 0 (429)'],
];
for (const [message, why] of dead) {
  pass(geminiModelIsUnavailable(new Error(message)) === true, `the chain moves on when the model is ${why}`);
}
const ours = [
  ['[400 Bad Request] Invalid JSON payload received', 'a malformed request'],
  ['[403 Forbidden] API key not valid', 'a bad API key'],
  ['Gemini (gemini-3-flash-preview) ran out of output tokens (maxTokens=4096) and its JSON is truncated.', 'a token budget too small for a reasoning model'],
];
for (const [message, why] of ours) {
  pass(geminiModelIsUnavailable(new Error(message)) === false,
    `but it surfaces ${why} immediately instead of blaming Google`);
}
// The truncation message must never be mistaken for an outage: it says "ran out" and names a
// budget, and a chain that retried it on two more models would report the wrong cause twice.
pass(GEMINI_FALLBACKS.length >= 2 && GEMINI_FALLBACKS.every((m) => typeof m === 'string' && m.includes('gemini')),
  'there is more than one Gemini model to fall back to', GEMINI_FALLBACKS.join(', '));

// --- reading an answer out of Claude and OpenAI ---------------------------------------
// The truncation invariant was enforced for Gemini only, and the other two providers had the
// identical failure waiting in them: a 200 carrying half an object, reported downstream as
// "the model did not return valid JSON" - which reads as a refusal and is a budget problem.
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

pass(extractClaudeText({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":1}' }] }) === '{"ok":1}',
  'a plain Claude answer reads back');
// The one that would have broken the migration silently: thinking is ON BY DEFAULT on the
// current models, so content[0] is a thinking block and the old `content[0].text` was undefined.
pass(extractClaudeText({
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"ok":1}' }],
}) === '{"ok":1}', 'the TEXT block is found even when a thinking block comes first');
pass(/truncated/i.test(threw(() => extractClaudeText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"na' }] }, { maxTokens: 4096 })) || ''),
  'Claude hitting max_tokens says TRUNCATED, not "no valid JSON"');
pass(/declined|refus/i.test(threw(() => extractClaudeText({ stop_reason: 'refusal', content: [] })) || ''),
  'a Claude safety refusal is named as a refusal, checked BEFORE content is read');
pass(threw(() => extractClaudeText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }] })) !== null,
  'an all-thinking response is an error, not an empty string handed to the parser');

pass(extractOpenAIText({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":1}' } }] }) === '{"ok":1}',
  'a plain OpenAI answer reads back');
pass(/truncated/i.test(threw(() => extractOpenAIText({ choices: [{ finish_reason: 'length', message: { content: '{"na' } }] }, { maxTokens: 4096 })) || ''),
  'OpenAI finish_reason=length says TRUNCATED too');

// --- telling a truncation from a refusal ------------------------------------------------
// "the model did not return valid JSON" is the most misleading message in this project: it
// reads as a refusal and is usually a budget problem. The old diagnostic printed the FIRST 200
// characters - the part that looks identical in both cases. The tail is what tells you.
pass(eq(parseJsonish('{"a":1}'), { a: 1 }), 'plain JSON parses');
pass(eq(parseJsonish('Here is the plan: {"a":1} hope that helps'), { a: 1 }), 'JSON wrapped in prose is recovered');
pass(eq(parseJsonish('```json\n{"a":1}\n```'), { a: 1 }), 'a fenced block is recovered');

const truncated = threw(() => parseJsonish('{"name":"Guard\'s Watchtower","ops":[{"op":"walls","x0":0'));
pass(/TRUNCATED/.test(truncated) && /unclosed/.test(truncated),
  'a cut-off reply is named as TRUNCATED, with the unclosed depth', truncated.slice(0, 90));
pass(/maxTokens/i.test(truncated), 'and it names the actual fix (raise the budget), not "reword the prompt"');
pass(/stops mid-string/.test(threw(() => parseJsonish('{"name":"Guard\'s Watch'))),
  'a reply cut off inside a string says so');
pass(/does not start with/.test(threw(() => parseJsonish('I cannot help with that request.'))),
  'a reply that is not JSON at all is a FORMAT problem, and says that instead');
pass(/empty/.test(threw(() => parseJsonish('   '))), 'an empty reply says empty');
// A brace inside a string must not be counted as structure, or balanced JSON reads as truncated.
pass(!/TRUNCATED/.test(threw(() => parseJsonish('{"desc":"a {cosy} hut [really]"}x')) || ''),
  'braces INSIDE strings do not count as structure');

// --- the /fill cap --------------------------------------------------------------------
// One /fill is refused above 32,768 blocks, silently. The crew's "let me clear the area
// first!" was a single fill over the plan's whole bounding box: every preset fits, but an ops
// build may legally span the plot to y=48 (122,112 blocks), so the clear vanished on exactly
// the builds that needed it most - while the coordinator's prompt promised the model a site
// bulldozed to bare earth.
const volume = ([ax, ay, az, bx, by, bz]) => (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
const covers = (boxes, x, y, z) =>
  boxes.filter(([ax, ay, az, bx, by, bz]) => x >= ax && x <= bx && y >= ay && y <= by && z >= az && z <= bz).length;

const small = fillPlan(0, 0, 0, 9, 9, 9);
pass(small.length === 1, 'a region under the cap is ONE command', `${small.length} fill(s)`);

// The worst case the ops limits allow: the whole plot, floor to ceiling.
const huge = fillPlan(-8, -4, -8, 39, 48, 39);
pass(volume([-8, -4, -8, 39, 48, 39]) === 122112, 'a full-plot ops build really is over the cap by 3.7x');
pass(huge.every((b) => volume(b) <= FILL_CAP), 'every piece of the split is under the cap',
  `${huge.length} fills, largest ${Math.max(...huge.map(volume))}`);
pass(huge.reduce((s, b) => s + volume(b), 0) === 122112, 'the pieces add up to the whole region - nothing is skipped');
pass(covers(huge, 12, 20, 12) === 1 && covers(huge, -8, -4, -8) === 1 && covers(huge, 39, 48, 39) === 1,
  'and they do not overlap - each block is filled exactly once, corners included');

// A long thin region must NOT be tiled into cubes: that is the difference between one command
// and ten for something like a shore ring.
pass(fillPlan(0, 0, 0, 2, 0, 288).length === 1, 'a long thin box stays a single command (split on volume, not on 32s)');
pass(fillPlan(39, 48, 39, -8, -4, -8).length === huge.length, 'corners given backwards are normalized, not dropped');

// OpenAI token params: GPT-5+/o-series reject max_tokens; older models still need it.
pass(openaiTokenParams('gpt-6-luna', 100).max_completion_tokens === 100 && !('max_tokens' in openaiTokenParams('gpt-6-luna', 100)),
  'gpt-6-luna gets max_completion_tokens, not max_tokens');
pass(openaiTokenParams('gpt-6-luna', 100).reasoning_effort === 'none', 'gpt-6-luna defaults to reasoning_effort none');
pass(openaiTokenParams('gpt-4o', 100).max_tokens === 100 && !('reasoning_effort' in openaiTokenParams('gpt-4o', 100)),
  'gpt-4o (a pinned OPENAI_MODEL) keeps max_tokens and no reasoning_effort');

console.log(failed ? `\n${failed} failure(s)` : '\nAll agent-loop checks passed.');
process.exit(failed ? 1 : 0);
