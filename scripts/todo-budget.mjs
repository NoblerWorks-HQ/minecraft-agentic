#!/usr/bin/env node
/**
 * todo-budget.mjs - keep TODO.md to open action lines, under a FIXED byte ceiling.
 * GENERATED - canonical source is engineering-standards/scripts/templates/todo-budget.mjs;
 * per-repo settings live in that repo's `.ci-local.json` key `todoBudget`, never in the copy.
 *
 *   node scripts/todo-budget.mjs --report            # sizes, what each step would reach, longest open lines
 *   node scripts/todo-budget.mjs                     # dry run: what --write would move
 *   node scripts/todo-budget.mjs --write             # move closed work into the quarter's archive
 *   node scripts/todo-budget.mjs --compact --write   # also move history tails off long open lines
 *   node scripts/todo-budget.mjs --prose --write     # also move open sections' older context (implies --compact)
 *   node scripts/todo-budget.mjs --backlog --write   # also move stale UNDATED open items to BACKLOG.md
 *   node scripts/todo-budget.mjs --check             # gate: exit 1 over the ceiling (or another budget)
 *   node scripts/todo-budget.mjs --staged            # pre-commit: check the STAGED TODO.md; auto-archive + re-stage
 *   --root <repo> reads another checkout; --out <dir> writes TODO.md + archive there instead (dry runs)
 *
 * WHY (2026-10-20, design approved by Patrick): nobler-os' archive-todo.mjs lifted only TICKED
 * lines, so its budget was raised 22 times in 3 weeks (176 KB -> 218 KB) while ~105 KB of the
 * file was section prose and history around open items. gitgood.dev (353 KB), semantix (350 KB)
 * and achilles (185 KB) had no archiver at all. And the check ran at PUSH, where a docs-only push
 * skips the gate entirely. So:
 *   1. TODO.md holds OPEN ACTION LINES: date, action, link to detail. Soft cap ~300 bytes a line,
 *      warn over 600. Context and history go to the commit or a linked doc.
 *   2. WHOLE SECTIONS archive, not just ticked lines: a `## ` section (or a `### ` subsection) with
 *      no open `- [ ]` left moves verbatim, prose and all. MOVE, NEVER DELETE: every removed line
 *      must be present in the archive, or the write is refused (verifyMove).
 *   3. A FIXED ceiling (default 120,000 bytes), not a ratchet. A repo may set its own in config,
 *      and every run then prints a loud warning saying so.
 *   4. Enforced on COMMIT (the stamped `.githooks/pre-commit` runs --staged), so docs-only
 *      pushes cannot route around it.
 *
 * CONFIG (`.ci-local.json` -> "todoBudget", every key optional):
 *   ceiling        bytes for TODO.md (default 120000; raising it warns on every run)
 *   ceilingReason  why, printed with that warning
 *   archiveDir     where TODO-ARCHIVE-<year>-Q<n>.md lives (default "docs")
 *   keepDays       a tick younger than this stays (default 0: every tick moves)
 *   recentDays     --compact never moves a note dated inside this window (default 7, = todo-sweep)
 *   otherBudgets   { "CLAUDE.md": 44000, ... } - extra byte budgets --check enforces
 *   keepSections   heading regexes that never archive (also: `<!-- todo-budget: keep -->` in a section)
 *   protectJson    JSON files whose string `todo` values are needles --compact must keep in their
 *                  line (nobler-os: scripts/judges.json - run-judges matches a judge by substring)
 *
 * The archive is append-only and never read at session start, so it has no budget. Generated
 * "N closed items archived" stub lines are pointers, not content: they are merged per section and
 * are the one thing verifyMove does not require in the archive.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLEET_CEILING = 120_000;
export const DEFAULTS = {
  ceiling: FLEET_CEILING,
  ceilingReason: '',
  archiveDir: 'docs',
  keepDays: 0,
  recentDays: 7,
  softLine: 300,
  hardLine: 600,
  otherBudgets: {},
  keepSections: [],
  protectJson: [],
  backlogFile: 'BACKLOG.md',
  backlogAfterDays: 14,
  backlogKeep: ['Patrick', '🔴', 'not deployed', 'NOT DEPLOYED', 'not applied', 'NOT APPLIED'],
};
const KEEP_MARK = '<!-- todo-budget: keep -->';

// ─── parsing ────────────────────────────────────────────────────────────────

export const OPEN_RE = /^\s*[-*] \[ \]/;
export const TICK_RE = /^\s*[-*] \[[xX]\]/;
const FENCE_RE = /^\s*(```|~~~)/;
const DATE_RE = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
export const STUB_RE = /^- \*(\d+) closed items? archived (?:\(last )?(\d{4}-\d\d-\d\d)\)?: \[([^\]]+)\]\(([^)#]+)#([^)]+)\)\*$/;
/** The --prose pointer. Also generated, also exempt from verifyMove. */
export const CONTEXT_RE = /^- \*Context archived \d{4}-\d\d-\d\d: \[[^\]]+\]\([^)#]+#[^)]+\)\*$/;

const bytes = (s) => Buffer.byteLength(s);
const iso = (d) => d.toISOString().slice(0, 10);

/** Newest YYYY-MM-DD in a block of text, as a Date (UTC), or null. */
export function newestDate(text) {
  let newest = null;
  for (const m of String(text).matchAll(DATE_RE)) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (Number.isNaN(d.getTime())) continue;
    if (!newest || d > newest) newest = d;
  }
  return newest;
}

/** GitHub-style heading slug (matches the archives written since 2026-09-05). */
export function slugify(heading) {
  return heading
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[`*~_[\]()<>!?.,:;'"/\\|+=&%$#@^{}]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Split at headings of `level` (2 = `## `), never inside a code fence. */
export function splitAt(lines, level) {
  const mark = `${'#'.repeat(level)} `;
  const head = [];
  const parts = [];
  let cur = null;
  let fence = false;
  for (const line of lines) {
    if (!fence && line.startsWith(mark)) {
      cur = { heading: line, body: [] };
      parts.push(cur);
      continue;
    }
    if (FENCE_RE.test(line)) fence = !fence;
    (cur ? cur.body : head).push(line);
  }
  return { head, parts };
}

export function splitSections(text) {
  const { head, parts } = splitAt(text.split('\n'), 2);
  return { preamble: head, sections: parts };
}

/**
 * Group a body into blocks: top-level list items (a `- `/`* ` line at column 0 plus every
 * following blank-or-indented line, trailing blanks excluded), fenced code (one block), and
 * everything else line by line.
 */
export function blocks(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i];
    if (/^[-*] /.test(line)) {
      let j = i + 1;
      let fence = false;
      while (j < body.length && (fence || body[j] === '' || /^\s/.test(body[j]))) {
        if (FENCE_RE.test(body[j])) fence = !fence;
        j++;
      }
      let end = j;
      while (end > i + 1 && body[end - 1] === '') end--;
      const lines = body.slice(i, end);
      out.push({ kind: 'item', lines, checked: TICK_RE.test(line), open: OPEN_RE.test(line), stub: STUB_RE.test(line) });
      i = end;
    } else if (FENCE_RE.test(line)) {
      let j = i + 1;
      while (j < body.length && !FENCE_RE.test(body[j])) j++;
      out.push({ kind: 'line', lines: body.slice(i, Math.min(j + 1, body.length)) });
      i = j + 1;
    } else {
      out.push({ kind: 'line', lines: [line] });
      i++;
    }
  }
  return out;
}

const hasOpen = (lines) => lines.some((l) => OPEN_RE.test(l));

export function archiveName(today, dir = DEFAULTS.archiveDir) {
  const q = Math.floor(today.getUTCMonth() / 3) + 1;
  return `${dir.replace(/\/+$/, '')}/TODO-ARCHIVE-${today.getUTCFullYear()}-Q${q}.md`;
}

// ─── planning ───────────────────────────────────────────────────────────────

function pinned(sec, cfg) {
  if (sec.body.some((l) => l.includes(KEEP_MARK))) return true;
  return (cfg.keepSections || []).some((re) => new RegExp(re, 'u').test(sec.heading));
}

const trimTail = (body) => {
  const b = [...body];
  while (b.length && (b.at(-1) === '' || b.at(-1) === '---')) b.pop();
  return b;
};

/** Two blank lines in a row are one; removal must not leave holes. */
function collapseBlanks(lines) {
  return lines.filter((l, i) => !(l === '' && lines[i - 1] === ''));
}

/** Removing whole sections can leave `---` directly under `---`. */
function collapseRules(text) {
  return text.replace(/(\n---\n)(\s*---\n)+/g, '$1').replace(/\n{3,}/g, '\n\n');
}

/** Is a tick old enough to move? keepDays 0 = always. */
const tickIsOld = (text, today, keepDays) => {
  if (!keepDays) return true;
  const d = newestDate(text);
  return !d || (today - d) / 86_400_000 > keepDays;
};

/**
 * One merged stub per section and archive file: "- *N closed items archived (last D): [f](f#slug)*".
 * `extra` = { count, date } for items moving now.
 */
function mergeStubs(bs, slug, file, extra, today) {
  const target = (b) => b.kind === 'item' && b.stub && STUB_RE.exec(b.lines[0])[4] === file;
  const stubs = bs.filter(target);
  let n = extra ? extra.count : 0;
  let last = extra ? iso(today) : '';
  for (const s of stubs) {
    const m = STUB_RE.exec(s.lines[0]);
    n += Number(m[1]);
    if (m[2] > last) last = m[2];
  }
  if (!n) return null;
  return `- *${n} closed item${n === 1 ? '' : 's'} archived (last ${last}): [${file}](${file}#${slug})*`;
}

/**
 * The section planner. Returns the new TODO.md text and the archive entries it needs:
 *   whole sections with no open item (verbatim, prose included),
 *   `### ` subsections with no open item, inside a section that still has one,
 *   ticked top-level items (with their continuation lines) that hold no open sub-item.
 * @returns {{ todo: string, entries: Entry[], stats }}
 * Entry = { anchor, heading, intro, lines, kind: 'section'|'subsection'|'items'|'history', items }
 */
export function plan(todoText, today, cfg = DEFAULTS, archiveFile = archiveName(today, cfg.archiveDir)) {
  const { preamble, sections } = splitSections(todoText);
  const entries = [];
  const kept = [...preamble];
  const stats = { sections: 0, subsections: 0, items: 0 };
  for (const sec of sections) {
    const slug = slugify(sec.heading);
    if (!hasOpen(sec.body) && !pinned(sec, cfg)) {
      entries.push({ kind: 'section', anchor: slug, heading: sec.heading, lines: trimTail(sec.body), items: sec.body.filter((l) => TICK_RE.test(l)).length });
      stats.sections++;
      continue;
    }
    // Subsections with nothing open move as a unit (heading + body).
    const { head, parts } = splitAt(sec.body, 3);
    const body = [...head];
    for (const sub of parts) {
      if (!hasOpen(sub.body) && !pinned(sub, cfg)) {
        entries.push({ kind: 'subsection', anchor: slug, heading: sec.heading, lines: [sub.heading, ...trimTail(sub.body), ''], items: 0 });
        stats.subsections++;
        // keep the `---` that separated this section from the next one
        if (sub.body.at(-1) === '---' || (sub.body.at(-1) === '' && sub.body.at(-2) === '---')) body.push('---', '');
      } else body.push(sub.heading, ...sub.body);
    }
    const bs = blocks(body);
    const moving = bs.filter((b) => b.kind === 'item' && b.checked && !hasOpen(b.lines) && tickIsOld(b.lines.join('\n'), today, cfg.keepDays));
    const stub = mergeStubs(bs, slug, archiveFile, moving.length ? { count: moving.length } : null, today);
    const out = [];
    let stubbed = false;
    for (const b of bs) {
      const isStub = b.kind === 'item' && b.stub && STUB_RE.exec(b.lines[0])[4] === archiveFile;
      if (moving.includes(b) || isStub) {
        if (stub && !stubbed) { out.push(stub); stubbed = true; }
        continue;
      }
      out.push(...b.lines);
    }
    if (moving.length) {
      entries.push({ kind: 'items', anchor: slug, heading: sec.heading, lines: moving.flatMap((b) => [...b.lines, '']), items: moving.length });
      stats.items += moving.length;
    }
    kept.push(sec.heading, ...collapseBlanks(out));
  }
  return { todo: collapseRules(kept.join('\n')), entries, stats };
}

// ─── backlog (undated, stale open items) ────────────────────────────────────

/** The pointer an emptied-out section keeps. Generated, so verify treats it as trivial. */
/** parse.py's DUE rule: a date after judge/by/before/due/re-check/revisit/until is a due date. */
const MIDLINE_DUE_RE = /\b(?:judge[sd]?|by|before|due|re-check|revisit|until)\b\W{0,4}(?:on\s+)?20\d\d-\d\d-\d\d/i;

export const BACKLOG_STUB_RE = /^- \*(\d+) undated items? moved to the backlog \(last (\d{4}-\d\d-\d\d)\): \[([^\]]+)\]\(([^)#]+)#([^)]+)\)\*$/;

/**
 * Should this open item block go to BACKLOG.md? Only when NOTHING makes it current:
 * no leading date, no judge id, no keep word (Patrick's actions, 🔴, built-not-deployed),
 * not in a pinned section, and no date in the item or its section heading newer than
 * backlogAfterDays (an item with no date anywhere counts as old).
 */
export function backlogEligible(block, heading, today, cfg) {
  const first = block.lines[0];
  if (!OPEN_RE.test(first) || block.stub) return false;
  if (leadingDate(first)) return false;
  const text = block.lines.join('\n');
  if (judgeIds(text).size) return false;
  // The fleet ledger (parse.py DUE) also reads a mid-line due date; and 🔁 items recur.
  if (MIDLINE_DUE_RE.test(text) || text.includes('🔁')) return false;
  if ((cfg.backlogKeep || []).some((w) => text.includes(w))) return false;
  const d = newestDate(`${heading}\n${text}`);
  return !d || (today - d) / 86_400_000 > cfg.backlogAfterDays;
}

export function newBacklog() {
  return [
    '# Backlog',
    '',
    '> Open items with no date and no owner action, moved out of `TODO.md` by `scripts/todo-budget.mjs --backlog`',
    '> once they were older than the repo\'s `backlogAfterDays`. **Still open, not archived.** Not read at session',
    '> start and has no byte budget. Give an item a leading `YYYY-MM-DD` (or move it by hand) and the next run puts',
    '> it back in `TODO.md`. Fleet design: engineering-standards `repo-and-project-structure.md` "TODO.md budget".',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Move stale undated open items TODO.md -> BACKLOG.md (grouped under their section heading),
 * and dated ones BACKLOG.md -> TODO.md. A section that loses items keeps one merged pointer.
 * @returns {{ todo, backlog, moved, restored }}
 */
export function planBacklog(todoText, backlogText, today, cfg = DEFAULTS) {
  const file = cfg.backlogFile || 'BACKLOG.md';
  const { preamble, sections } = splitSections(todoText);
  const kept = [...preamble];
  const entries = [];
  let moved = 0;
  for (const sec of sections) {
    if (pinned(sec, cfg)) { kept.push(sec.heading, ...sec.body); continue; }
    const slug = slugify(sec.heading);
    const bs = blocks(sec.body);
    const going = bs.filter((b) => b.kind === 'item' && backlogEligible(b, sec.heading, today, cfg));
    const old = bs.filter((b) => b.kind === 'item' && BACKLOG_STUB_RE.test(b.lines[0]));
    let n = going.length;
    let last = going.length ? iso(today) : '';
    for (const o of old) { const m = BACKLOG_STUB_RE.exec(o.lines[0]); n += Number(m[1]); if (m[2] > last) last = m[2]; }
    const stub = n ? `- *${n} undated item${n === 1 ? '' : 's'} moved to the backlog (last ${last}): [${file}](${file}#${slug})*` : null;
    const out = [];
    let stubbed = false;
    for (const b of bs) {
      if (going.includes(b) || old.includes(b)) {
        if (stub && !stubbed) { out.push(stub); stubbed = true; }
        continue;
      }
      out.push(...b.lines);
    }
    if (going.length) {
      entries.push({ anchor: slug, heading: sec.heading, lines: going.flatMap((b) => [...b.lines, '']) });
      moved += going.length;
    }
    kept.push(sec.heading, ...collapseBlanks(out));
  }
  let todo = collapseRules(kept.join('\n'));

  // Back the other way: a backlog item that now has a leading date is current again.
  let backlog = backlogText ?? newBacklog();
  let restored = 0;
  if (backlogText) {
    const bl = splitSections(backlogText);
    const keptB = [...bl.preamble];
    const back = [];
    for (const sec of bl.sections) {
      const bs = blocks(sec.body);
      const returning = bs.filter((b) => b.kind === 'item' && OPEN_RE.test(b.lines[0]) && leadingDate(b.lines[0]));
      if (returning.length) back.push({ heading: sec.heading, lines: returning.flatMap((b) => b.lines) });
      restored += returning.length;
      const rest = bs.filter((b) => !returning.includes(b)).flatMap((b) => b.lines);
      if (rest.some((l) => OPEN_RE.test(l) || TICK_RE.test(l))) keptB.push(sec.heading, ...collapseBlanks(rest));
    }
    if (restored) {
      backlog = collapseRules(keptB.join('\n'));
      todo = restoreInto(todo, back);
    }
  }
  if (entries.length) backlog = applyToArchive(backlog, entries.map((e) => ({ ...e, kind: 'items', intro: '' })), today);
  return { todo, backlog, moved, restored, file };
}

/**
 * Put dated-again items back under their ORIGINAL section heading (recreated at the end if that
 * section has since been archived), decrementing that section's backlog pointer, so the item
 * returns where it was and its fleet-ledger id depends only on its own text.
 */
function restoreInto(todoText, back) {
  const { preamble, sections } = splitSections(todoText);
  const out = [...preamble];
  const pending = new Map(back.map((b) => [b.heading, b.lines]));
  for (const sec of sections) {
    const add = pending.get(sec.heading);
    if (!add) { out.push(sec.heading, ...sec.body); continue; }
    pending.delete(sec.heading);
    const n = add.filter((l) => OPEN_RE.test(l)).length;
    const body = [];
    let placed = false;
    for (const l of sec.body) {
      const m = BACKLOG_STUB_RE.exec(l);
      if (m && !placed) {
        const left = Number(m[1]) - n;
        if (left > 0) body.push(l.replace(/^- \*\d+ undated items?/, `- *${left} undated item${left === 1 ? '' : 's'}`));
        body.push(...add);
        placed = true;
        continue;
      }
      body.push(l);
    }
    if (!placed) {
      while (body.length && body.at(-1) === '') body.pop();
      body.push(...add, '');
    }
    out.push(sec.heading, ...body);
  }
  let text = out.join('\n');
  for (const [heading, lines] of pending) text = `${text.replace(/\n*$/, '\n')}\n${heading}\n\n${lines.join('\n')}\n`;
  return collapseRules(text);
}

/** Open items are conserved across TODO.md + BACKLOG.md, and no other line disappears. */
export function verifyBacklog(oldTodo, newTodo, oldBacklog, newBacklog) {
  const problems = [];
  const all = (a, b) => counts([...a.split('\n'), ...b.split('\n')]);
  const before = all(oldTodo, oldBacklog);
  const after = all(newTodo, newBacklog);
  for (const [l, n] of before) {
    if (trivial(l) || BACKLOG_STUB_RE.test(l) || /^## /.test(l) || /^<a id=/.test(l)) continue;
    if ((after.get(l) || 0) < n) problems.push(`lost in the backlog move: ${l.slice(0, 120)}`);
  }
  const open = (t) => t.split('\n').filter((l) => OPEN_RE.test(l)).length;
  if (open(oldTodo) + open(oldBacklog) !== open(newTodo) + open(newBacklog)) problems.push(`open items: ${open(oldTodo) + open(oldBacklog)} before, ${open(newTodo) + open(newBacklog)} after (TODO.md + backlog)`);
  return problems;
}

// ─── compaction (open lines) ────────────────────────────────────────────────

/** Where an open item's ACTION text starts: after `- [ ] `. */
const actionOf = (line) => line.replace(/^\s*[-*] \[ \]\s*/, '');

/** Judge ids a line names: `judge \`x\``, `judges: \`a\`, \`b\``. */
export function judgeIds(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/\bjudge[sd]?\b[^`\n]{0,24}((?:`[^`]+`[\s,;and&+]*)+)/gi)) {
    for (const t of m[1].matchAll(/`([^`]+)`/g)) ids.add(t[1]);
  }
  return ids;
}

/** The leading date of an open item's action, or ''. */
export function leadingDate(line) {
  const m = /^[\s*_~🔴🟠🟡🟢⚠️✏️]*\(?(20\d\d-\d\d-\d\d)/u.exec(actionOf(line));
  return m ? m[1] : '';
}

/** What must not change about an open item: [leading date, judge ids, first 80 chars of action]. */
export function openKey(line) {
  return `${leadingDate(line)}|${[...judgeIds(line)].sort().join(',')}|${actionOf(line).slice(0, 80)}`;
}

/** Stable per-item anchor for its history entry. */
export const historyAnchor = (line) => `c-${createHash('sha1').update(actionOf(line).slice(0, 80)).digest('hex').slice(0, 8)}`;

const HISTORY_SPLIT = / (?=(?:✏️|✅)\s*\**\s*(?:\(|20\d\d-\d\d-\d\d|interim|later|moved|was|update|done|fixed|deployed|live))/giu;
const MIN_HEAD = 120;

/**
 * Split an open item line into [head, ...history segments]. A history segment starts at a
 * ` ✏️ ` / ` ✅ ` stamp; any stamp inside the first MIN_HEAD characters of the action belongs to
 * the head (so the action's opening text, its leading date and the todo-sweep key never move).
 */
export function historySegments(line) {
  const prefixLen = line.length - actionOf(line).length;
  const cuts = [];
  for (const m of line.matchAll(HISTORY_SPLIT)) if (m.index >= prefixLen + MIN_HEAD) cuts.push(m.index);
  if (!cuts.length) return [line];
  const segs = [line.slice(0, cuts[0])];
  cuts.forEach((c, i) => segs.push(line.slice(c, cuts[i + 1] ?? line.length)));
  return segs;
}

/** True when a segment may move: dated before `cutoff`, no judge id, no protected needle, no marker comment. */
function movable(seg, cutoff, needles) {
  const d = newestDate(seg);
  if (d && iso(d) >= cutoff) return false;
  if (judgeIds(seg).size) return false;
  if (/<!--/.test(seg)) return false;
  return !needles.some((n) => n && seg.includes(n));
}

/**
 * Shorten oversized open lines by MOVING history off them. Per open top-level item over
 * `softLine` bytes:
 *   - its ✏️/✅ history segments move, except the LAST one (the current state) and any dated
 *     inside `recentDays` (todo-sweep reads those as "judged recently");
 *   - its continuation lines that are history (lead with ✏️/✅/Was:/Note/a date) and are older
 *     than `recentDays` move too;
 *   - the line gets ` ([history](<archive>#c-xxxxxxxx))` once.
 * The archive gets the item's FULL original text (line + continuation) under that anchor, so
 * every removed byte is there. A line is only rewritten when that saves >= 100 bytes.
 * `isProtected(item)` (optional) skips an item outright.
 */
export function compact(todoText, today, cfg = DEFAULTS, archiveFile = archiveName(today, cfg.archiveDir), { needles = [], isProtected = () => false, prose = false } = {}) {
  const cutoff = iso(new Date(today.getTime() - (cfg.recentDays ?? 7) * 86_400_000));
  const { preamble, sections } = splitSections(todoText);
  const entries = [];
  const out = [...preamble];
  let lines = 0;
  let proseSections = 0;
  for (const sec of sections) {
    out.push(sec.heading);
    const bs = blocks(sec.body);
    // --prose: a section's context (paragraphs, plain bullets) moves to the archive under the
    // section's anchor, leaving one pointer. Kept: open items, ticked parents of open sub-items,
    // `### ` headings, code fences (often the command an open item needs), `---`, stubs, keep marks.
    const moveProse = new Set();
    if (prose && hasOpen(sec.body) && !pinned(sec, cfg)) {
      const secDate = newestDate(sec.heading);
      for (const b of bs) {
        const t = b.lines.join('\n');
        const isProse = b.kind === 'line'
          ? t.trim() !== '' && t.trim() !== '---' && !/^#{3,} /.test(t) && !FENCE_RE.test(b.lines[0]) && !t.includes(KEEP_MARK)
          : !b.open && !b.stub && !hasOpen(b.lines) && !t.includes(KEEP_MARK) && !b.lines.some((l) => FENCE_RE.test(l));
        if (!isProse || /<!--/.test(t) || judgeIds(t).size || needles.some((n) => n && t.includes(n))) continue;
        const d = newestDate(t) || secDate;
        if (d && iso(d) >= cutoff) continue;
        moveProse.add(b);
      }
    }
    if (moveProse.size) {
      const slug = slugify(sec.heading);
      const moved = bs.filter((b) => moveProse.has(b));
      entries.push({ kind: 'prose', anchor: slug, heading: sec.heading, intro: `*Section context lifted from \`TODO.md\` ${iso(today)}; the section's open items stay there.*`, lines: [...moved.flatMap((b) => b.lines), ''], items: 0 });
      proseSections++;
    }
    let pointed = false;
    for (const b of bs) {
      if (moveProse.has(b)) {
        if (!pointed) { out.push(`- *Context archived ${iso(today)}: [${archiveFile}](${archiveFile}#${slugify(sec.heading)})*`); pointed = true; }
        continue;
      }
      if (b.kind !== 'item' || !b.open) { out.push(...b.lines); continue; }
      const [first, ...rest] = b.lines;
      if (bytes(first) <= cfg.softLine && !rest.length) { out.push(...b.lines); continue; }
      if (isProtected({ heading: sec.heading, line: first, lines: b.lines })) { out.push(...b.lines); continue; }
      const segs = historySegments(first);
      const keepSegs = [segs[0]];
      let movedAny = false;
      if (bytes(first) > cfg.softLine) {
        segs.slice(1).forEach((s, i, arr) => {
          if (i === arr.length - 1 || !movable(s, cutoff, needles)) keepSegs.push(s);
          else movedAny = true;
        });
      } else keepSegs.push(...segs.slice(1));
      // Continuation lines: history lines of this item, and its TICKED sub-items (closed work,
      // with their deeper-indented lines) unless one holds an open box or a recent date.
      const keptRest = [];
      const ind = (l) => l.length - l.trimStart().length;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i];
        if (TICK_RE.test(l)) {
          let j = i + 1;
          while (j < rest.length && rest[j].trim() && ind(rest[j]) > ind(l)) j++;
          const sub = rest.slice(i, j);
          if (!hasOpen(sub) && movable(sub.join('\n'), cutoff, needles)) { movedAny = true; i = j - 1; continue; }
          keptRest.push(...sub); i = j - 1; continue;
        }
        const hist = !OPEN_RE.test(l) && /^\s+(?:[-*]\s+)?(?:\*\*|_|\()*\s*(?:✏️|✅|Was:|Note[sd]?\b|Update[sd]?\b|20\d\d-\d\d-\d\d)/iu.test(l);
        if (hist && l.trim() && movable(l, cutoff, needles) && newestDate(l)) movedAny = true;
        else keptRest.push(l);
      }
      if (!movedAny) { out.push(...b.lines); continue; }
      const anchor = historyAnchor(first);
      const link = ` ([history](${archiveFile}#${anchor}))`;
      const head = keepSegs.join('').replace(/\s+$/, '');
      const linked = b.lines.some((l) => l.includes(`#${anchor})`));
      // A short line gets the link on its own continuation line: appended, it would change the
      // first 80 characters of the action, which every reader keys on.
      const after = linked ? [head, ...collapseBlanks(keptRest)]
        : actionOf(head).length >= 80 ? [head + link, ...collapseBlanks(keptRest)]
        : [head, `  ${link.trim()}`, ...collapseBlanks(keptRest)];
      if (bytes(b.lines.join('\n')) - bytes(after.join('\n')) < 100) { out.push(...b.lines); continue; }
      out.push(...after);
      lines++;
      entries.push({
        kind: 'history', anchor, heading: `### Open item history: ${actionOf(first).replace(/[*`_~[\]]/g, '').slice(0, 70).trim()}`,
        intro: `*History moved off an open \`TODO.md\` item ${iso(today)} (section "${sec.heading.replace(/^##\s*/, '').slice(0, 80)}"). The item is still OPEN there; this is its full text at the time.*`,
        lines: [...b.lines, ''], items: 0,
      });
    }
  }
  return { todo: collapseRules(collapseBlanks(out).join('\n')), entries, stats: { lines, proseSections } };
}

// ─── the archive ────────────────────────────────────────────────────────────

export function newArchive(file) {
  const q = file.match(/(\d{4})-Q(\d)/);
  return [
    `# TODO Archive - ${q[1]} Q${q[2]}`,
    '',
    '> Work lifted out of the root `TODO.md` by `scripts/todo-budget.mjs` (whole sections with nothing',
    '> open, closed items, and the history of long open lines). **Nothing here is pending**, with one',
    '> kind of exception: an "Open item history" entry holds the full earlier text of an item that is',
    '> still open in [`TODO.md`](../TODO.md) - the open item lives there, not here.',
    '',
    '---',
    '',
  ].join('\n');
}

const INTRO = {
  section: (d) => `*Whole section lifted from \`TODO.md\` ${d}; nothing in it was open.*`,
  subsection: (d) => `*Subsection lifted from \`TODO.md\` ${d}; nothing in it was open.*`,
  items: () => '',
  prose: () => '',
};

/** Insert entries into the archive text, each under its anchor (appended to when it exists). */
export function applyToArchive(archiveText, entries, today) {
  let text = archiveText;
  for (const e of entries) {
    const anchor = `<a id="${e.anchor}"></a>`;
    const intro = e.intro ?? INTRO[e.kind](iso(today));
    const body = [...(intro ? [intro, ''] : []), ...e.lines];
    const idx = text.indexOf(anchor);
    if (idx === -1) {
      text = `${text.replace(/\n*$/, '\n')}\n${anchor}\n\n${e.heading}\n\n${body.join('\n').replace(/\n*$/, '\n')}`;
    } else {
      const next = text.indexOf('\n<a id="', idx + anchor.length);
      const at = next === -1 ? text.length : next;
      const before = text.slice(0, at).replace(/\n*$/, '\n');
      text = `${before}\n${body.join('\n').replace(/\n*$/, '\n')}${text.slice(at)}`;
    }
  }
  return text;
}

// ─── the invariant ──────────────────────────────────────────────────────────

const counts = (lines) => {
  const m = new Map();
  for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
  return m;
};
const trivial = (l) => l.trim() === '' || l.trim() === '---' || STUB_RE.test(l) || CONTEXT_RE.test(l);

/**
 * MOVE, NEVER DELETE. Every line that left TODO.md (or changed) must have been ADDED to the
 * archive at least as many times; blank lines, `---` and generated stubs excepted. And the open
 * items, in order, keep their [leading date, judge ids, first 80 chars]. Returns problems ([] = ok).
 */
export function verifyMove(oldTodo, newTodo, oldArchive, newArchive) {
  const problems = [];
  const before = counts(oldTodo.split('\n'));
  const after = counts(newTodo.split('\n'));
  const archBefore = counts(oldArchive.split('\n'));
  const added = new Map();
  for (const [l, n] of counts(newArchive.split('\n'))) {
    const d = n - (archBefore.get(l) || 0);
    if (d > 0) added.set(l, d);
  }
  for (const [l, n] of before) {
    if (trivial(l)) continue;
    // A section heading whose archive entry already exists is not re-written under it.
    if (/^#{2,3} /.test(l) && newArchive.split('\n').includes(l)) continue;
    const gone = n - (after.get(l) || 0);
    if (gone > 0 && (added.get(l) || 0) < gone) problems.push(`removed but not in the archive: ${l.slice(0, 120)}`);
  }
  const ok = (t) => t.split('\n').filter((l) => OPEN_RE.test(l)).map(openKey);
  const a = ok(oldTodo);
  const b = ok(newTodo);
  if (a.length !== b.length) problems.push(`open items: ${a.length} before, ${b.length} after`);
  else a.forEach((k, i) => { if (k !== b[i]) problems.push(`open item ${i + 1} changed its date / judge ids / opening text: ${k.slice(0, 120)} -> ${b[i].slice(0, 120)}`); });
  return problems;
}

// ─── measuring ──────────────────────────────────────────────────────────────

export function measure(text, cfg = DEFAULTS) {
  const lines = text.split('\n');
  const open = lines.filter((l) => OPEN_RE.test(l));
  const ticked = lines.filter((l) => TICK_RE.test(l));
  const sum = (ls) => ls.reduce((n, l) => n + bytes(l) + 1, 0);
  const { sections } = splitSections(text);
  return {
    size: bytes(text),
    openLines: open.length,
    openBytes: sum(open),
    tickedLines: ticked.length,
    tickedBytes: sum(ticked),
    otherBytes: bytes(text) - sum(open) - sum(ticked),
    sections: sections.length,
    sectionsNoOpen: sections.filter((s) => !hasOpen(s.body)).length,
    overSoft: open.filter((l) => bytes(l) > cfg.softLine).length,
    overHard: open.filter((l) => bytes(l) > cfg.hardLine).length,
  };
}

export function loadConfig(root) {
  const p = join(root, '.ci-local.json');
  let user = {};
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.todoBudget && typeof j.todoBudget === 'object') user = j.todoBudget;
  }
  return { ...DEFAULTS, ...user };
}

/** The loud line every run prints when a repo set a ceiling above the fleet's. */
export function ceilingWarning(cfg) {
  if (cfg.ceiling <= FLEET_CEILING) return null;
  return `⚠️  TODO.md CEILING RAISED: ${cfg.ceiling.toLocaleString()} bytes > the fleet's fixed ${FLEET_CEILING.toLocaleString()} (.ci-local.json todoBudget.ceiling)${cfg.ceilingReason ? ` - ${cfg.ceilingReason}` : ' - NO REASON GIVEN'}. Lower it; never raise it to fit a commit.`;
}

export function needlesFrom(root, cfg) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string' && key === 'todo') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const f of cfg.protectJson || []) {
    const p = join(root, f);
    if (existsSync(p)) walk(JSON.parse(readFileSync(p, 'utf8')), '');
  }
  return out;
}

/** Plan the whole write: sections/ticks, then (optionally) compaction, and the archive text. */
export function planAll(todoText, archiveText, today, cfg, { compact: doCompact = false, prose = false, needles = [], isProtected } = {}) {
  const file = archiveName(today, cfg.archiveDir);
  const s = plan(todoText, today, cfg, file);
  let todo = s.todo;
  let entries = s.entries;
  let compacted = 0;
  let proseSections = 0;
  if (doCompact) {
    const c = compact(todo, today, cfg, file, { needles, isProtected, prose });
    todo = c.todo;
    entries = [...entries, ...c.entries];
    compacted = c.stats.lines;
    proseSections = c.stats.proseSections;
  }
  const archive = entries.length ? applyToArchive(archiveText ?? newArchive(file), entries, today) : (archiveText ?? '');
  return { file, todo, archive, entries, stats: { ...s.stats, compacted, proseSections }, afterSections: bytes(s.todo) };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function todayLocal() {
  if (process.env.TODO_BUDGET_TODAY) return new Date(`${process.env.TODO_BUDGET_TODAY}T00:00:00Z`);
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

const fmt = (n) => n.toLocaleString('en-US');
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function main(argv) {
  const args = new Set(argv);
  const val = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
  const root = resolve(val('--root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const outDir = val('--out') ? resolve(val('--out')) : root;
  const cfg = loadConfig(root);
  const today = todayLocal();
  const warn = ceilingWarning(cfg);
  if (warn) console.error(warn);
  const todoPath = join(root, 'TODO.md');
  const file = archiveName(today, cfg.archiveDir);
  const archivePath = join(root, file);
  const readArchive = () => (existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : null);
  const needles = needlesFrom(root, cfg);

  if (args.has('--staged')) return staged(root, cfg, today, file);

  if (!existsSync(todoPath)) { console.error(`[todo-budget] UNCHECKED: no TODO.md in ${root}`); return 1; }
  const origTodo = readFileSync(todoPath, 'utf8');
  let todoText = origTodo;
  const backlogPath = join(root, cfg.backlogFile);
  const origBacklog = existsSync(backlogPath) ? readFileSync(backlogPath, 'utf8') : null;
  let bk = null;
  if (args.has('--backlog')) {
    bk = planBacklog(origTodo, origBacklog, today, cfg);
    const bp = verifyBacklog(origTodo, bk.todo, origBacklog ?? '', bk.backlog);
    if (bp.length) { console.error(`[todo-budget] REFUSED: the backlog move would lose content:\n  ${bp.slice(0, 10).join('\n  ')}`); return 1; }
    console.log(`backlog: ${bk.moved} undated item(s) -> ${cfg.backlogFile}, ${bk.restored} dated item(s) back to TODO.md`);
    todoText = bk.todo;
  }

  if (args.has('--check')) {
    let bad = 0;
    const rows = [['TODO.md', bytes(todoText), cfg.ceiling], ...Object.entries(cfg.otherBudgets || {}).map(([f, b]) => [f, existsSync(join(root, f)) ? bytes(readFileSync(join(root, f), 'utf8')) : null, b])];
    for (const [f, size, budget] of rows) {
      if (size === null) { console.log(`  UNCHECKED ${f}: not found (listed in todoBudget.otherBudgets)`); bad++; continue; }
      const ok = size <= budget;
      console.log(`  ${ok ? 'ok  ' : 'OVER'} ${f}: ${fmt(size)} / ${fmt(budget)} bytes`);
      if (!ok) bad++;
    }
    const m = measure(todoText, cfg);
    if (m.overHard) console.log(`  warn: ${m.overHard} open TODO.md line(s) over ${cfg.hardLine} bytes - \`node scripts/todo-budget.mjs --report\` lists them`);
    if (bad) {
      const p = planAll(todoText, readArchive(), today, cfg);
      const pc = planAll(todoText, readArchive(), today, cfg, { compact: true, needles });
      console.log('');
      console.log(`  TODO.md: \`node scripts/todo-budget.mjs --write\` -> ${fmt(bytes(p.todo))} bytes; with --compact -> ${fmt(bytes(pc.todo))}.`);
      console.log('  Still over after both? The OPEN list is over: shorten lines (history to the commit or a doc), close items. The ceiling is fixed.');
      if (rows.slice(1).some(([, s, b]) => s !== null && s > b)) console.log('  Other files: move the new detail into the doc a Documentation Map row points at and leave a pointer.');
      return 1;
    }
    return 0;
  }

  const p = planAll(todoText, readArchive(), today, cfg, { compact: args.has('--compact') || args.has('--prose'), prose: args.has('--prose'), needles });
  const before = bytes(origTodo);
  const after = bytes(p.todo);

  if (args.has('--report')) {
    const m = measure(todoText, cfg);
    const c = planAll(todoText, readArchive(), today, cfg, { compact: true, needles });
    const ma = measure(c.todo, cfg);
    console.log(`TODO.md ${root}`);
    console.log(`  size            ${fmt(m.size)} bytes   ceiling ${fmt(cfg.ceiling)}${cfg.ceiling > FLEET_CEILING ? ' (RAISED)' : ''}`);
    console.log(`  open lines      ${fmt(m.openLines)} lines, ${fmt(m.openBytes)} bytes   (> ${cfg.softLine} B: ${m.overSoft}, > ${cfg.hardLine} B: ${m.overHard})`);
    console.log(`  ticked lines    ${fmt(m.tickedLines)} lines, ${fmt(m.tickedBytes)} bytes`);
    console.log(`  everything else ${fmt(m.otherBytes)} bytes (headings, prose, continuation, stubs)`);
    console.log(`  sections        ${m.sections} (${m.sectionsNoOpen} with no open item)`);
    console.log(`  after --write            ${fmt(c.afterSections)} bytes  (${c.stats.sections} sections, ${c.stats.subsections} subsections, ${c.stats.items} ticked items)`);
    const pr = planAll(todoText, readArchive(), today, cfg, { compact: true, prose: true, needles });
    console.log(`  after --compact --write  ${fmt(bytes(c.todo))} bytes  (${c.stats.compacted} open lines shortened; > ${cfg.hardLine} B left: ${ma.overHard})`);
    console.log(`  after --prose --write    ${fmt(bytes(pr.todo))} bytes  (+ context of ${pr.stats.proseSections} open sections, older than ${cfg.recentDays} days)`);
    const bl = planBacklog(todoText, origBacklog, today, cfg);
    const pb = planAll(bl.todo, readArchive(), today, cfg, { compact: true, needles });
    console.log(`  after --backlog --compact --write  ${fmt(bytes(pb.todo))} bytes  (${bl.moved} undated items older than ${cfg.backlogAfterDays} days -> ${cfg.backlogFile})`);
    const best = bytes(c.todo) <= cfg.ceiling ? 'reachable by --write/--compact' : bytes(pr.todo) <= cfg.ceiling ? 'reachable only with --prose (section context moves out)' : `${fmt(bytes(pr.todo) - cfg.ceiling)} bytes over even with --prose - the open list itself must shrink`;
    console.log(`  verdict: ${best}`);
    const longest = todoText.split('\n').map((l, i) => ({ l, i })).filter((x) => OPEN_RE.test(x.l)).sort((a, b) => bytes(b.l) - bytes(a.l)).slice(0, 10);
    console.log('  longest open lines:');
    for (const x of longest) console.log(`    ${String(x.i + 1).padStart(5)}  ${String(bytes(x.l)).padStart(5)} B  ${x.l.trim().slice(0, 90)}`);
    return 0;
  }

  console.log(`TODO.md: ${fmt(before)} -> ${fmt(after)} bytes; ${p.stats.sections} sections, ${p.stats.subsections} subsections, ${p.stats.items} ticked items${p.stats.compacted || p.stats.proseSections ? `, ${p.stats.compacted} open lines compacted, ${p.stats.proseSections} sections' context` : ''} -> ${file}`);
  for (const e of p.entries) console.log(`  ${e.kind.padEnd(10)} ${(e.kind === 'history' ? e.heading.slice(23) : e.kind === 'subsection' ? e.lines[0].slice(4) : e.heading.slice(3)).slice(0, 100)}`);
  const problems = verifyMove(todoText, p.todo, readArchive() ?? '', p.archive);
  if (problems.length) {
    console.error(`[todo-budget] REFUSED: the planned move would lose content:\n  ${problems.slice(0, 10).join('\n  ')}`);
    return 1;
  }
  if (!args.has('--write')) { console.log('\n(dry run - --write to move them)'); return 0; }
  if (!p.entries.length && p.todo === origTodo) return 0;
  const outTodo = join(outDir, 'TODO.md');
  const outArch = join(outDir, file);
  mkdirSync(dirname(outArch), { recursive: true });
  if (p.entries.length) writeFileSync(outArch, p.archive);
  if (bk && (bk.moved || bk.restored)) writeFileSync(join(outDir, cfg.backlogFile), bk.backlog);
  writeFileSync(outTodo, p.todo);
  console.log(`Wrote ${outTodo}${p.entries.length ? ` and ${outArch}` : ''}.`);
  return 0;
}

/** Pre-commit: judge the STAGED TODO.md; auto-archive + re-stage when that alone fits. */
function staged(root, cfg, today, file) {
  const show = git(root, 'show', ':TODO.md');
  if (show.status !== 0) return 0; // TODO.md not in the index (deleted / never added)
  let text = show.stdout;
  // A staged backlog item that gained a leading date goes back to TODO.md now.
  const bshow = git(root, 'show', `:${cfg.backlogFile}`);
  if (bshow.status === 0 && bshow.stdout.split('\n').some((l) => OPEN_RE.test(l) && leadingDate(l))) {
    const workT = readFileSync(join(root, 'TODO.md'), 'utf8');
    const workB = readFileSync(join(root, cfg.backlogFile), 'utf8');
    if (workT !== text || workB !== bshow.stdout) {
      console.error(`[todo-budget] ${cfg.backlogFile} has a dated item to move back, but TODO.md or ${cfg.backlogFile} has unstaged changes. Stage both and commit again.`);
      return 1;
    }
    const r = planBacklog(text, bshow.stdout, today, { ...cfg, backlogAfterDays: Infinity });
    if (r.restored && !verifyBacklog(text, r.todo, bshow.stdout, r.backlog).length) {
      writeFileSync(join(root, 'TODO.md'), r.todo);
      writeFileSync(join(root, cfg.backlogFile), r.backlog);
      git(root, 'add', '--', 'TODO.md', cfg.backlogFile);
      console.error(`[todo-budget] ${r.restored} dated item(s) moved back from ${cfg.backlogFile} to TODO.md (re-staged).`);
      text = r.todo;
    }
  }
  const size = bytes(text);
  const headText = git(root, 'show', 'HEAD:TODO.md').stdout || '';
  const old = new Set(headText.split('\n'));
  const fresh = text.split('\n').filter((l) => OPEN_RE.test(l) && !old.has(l) && bytes(l) > cfg.hardLine);
  for (const l of fresh) console.error(`[todo-budget] warn: a new open line is ${bytes(l)} bytes (soft cap ${cfg.softLine}): ${l.trim().slice(0, 90)}...`);
  if (size <= cfg.ceiling) return 0;
  const archivePath = join(root, file);
  const archText = existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : null;
  const backlogPath = join(root, cfg.backlogFile);
  const backText = existsSync(backlogPath) ? readFileSync(backlogPath, 'utf8') : null;
  let p = planAll(text, archText, today, cfg);
  let bk = null;
  if (bytes(p.todo) > cfg.ceiling) {
    // Archiving alone is not enough: move stale undated items to the backlog first.
    bk = planBacklog(text, backText, today, cfg);
    if (verifyBacklog(text, bk.todo, backText ?? '', bk.backlog).length) bk = null;
    else p = planAll(bk.todo, archText, today, cfg);
  }
  const after = bytes(p.todo);
  const head = `[todo-budget] staged TODO.md is ${fmt(size)} bytes, over its ${fmt(cfg.ceiling)}-byte ceiling.`;
  if (after > cfg.ceiling) {
    // A commit that SHRINKS an over-ceiling TODO.md is progress, never refused (todo-compact's
    // commits, a hand compaction pass); only growth past the ceiling is.
    const headSize = bytes(headText);
    if (headText && size < headSize) {
      console.error(`[todo-budget] warn: staged TODO.md is ${fmt(size)} bytes, ${fmt(size - cfg.ceiling)} over its ${fmt(cfg.ceiling)}-byte ceiling - allowed because it shrinks (HEAD ${fmt(headSize)}).`);
      return 0;
    }
    console.error(head);
    console.error(`  Archiving closed sections/items alone reaches ${fmt(after)} bytes - still ${fmt(after - cfg.ceiling)} over. The OPEN list must shrink:`);
    console.error('    node scripts/todo-budget.mjs --report              # the longest open lines');
    console.error('    node scripts/todo-budget.mjs --compact --write     # move their history tails to the archive');
    console.error('  then shorten or close what is left, `git add TODO.md docs/`, and commit again.');
    return 1;
  }
  const work = existsSync(join(root, 'TODO.md')) ? readFileSync(join(root, 'TODO.md'), 'utf8') : null;
  if (work !== text) {
    console.error(head);
    console.error('  TODO.md has unstaged changes, so the hook will not rewrite it. Run, then commit again:');
    console.error('    node scripts/todo-budget.mjs --write && git add TODO.md ' + file);
    return 1;
  }
  const problems = verifyMove(bk ? bk.todo : text, p.todo, archText ?? '', p.archive);
  if (problems.length) { console.error(`${head}\n[todo-budget] REFUSED to auto-archive: ${problems[0]}`); return 1; }
  mkdirSync(dirname(archivePath), { recursive: true });
  if (p.entries.length) writeFileSync(archivePath, p.archive);
  if (bk && bk.moved) writeFileSync(backlogPath, bk.backlog);
  writeFileSync(join(root, 'TODO.md'), p.todo);
  const add = git(root, 'add', '--', 'TODO.md', ...(p.entries.length ? [file] : []), ...(bk && bk.moved ? [cfg.backlogFile] : []));
  if (add.status !== 0) { console.error(`[todo-budget] git add failed: ${add.stderr}`); return 1; }
  if (bk && bk.moved) console.error(`[todo-budget] ${bk.moved} undated item(s) older than ${cfg.backlogAfterDays} days -> ${cfg.backlogFile} (re-staged).`);
  console.error(`[todo-budget] auto-archived: TODO.md ${fmt(size)} -> ${fmt(after)} bytes (${p.stats.sections} sections, ${p.stats.subsections} subsections, ${p.stats.items} ticked items -> ${file}); both re-staged.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
