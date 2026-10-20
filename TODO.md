# TODO

Working task list for **minecraft-agentic**. Read this at the start of a work session and keep it current as work completes - check items off with a date, add follow-ups as they surface. Stale TODOs are worse than none. Security debt (if any) is tracked separately in `SECURITY-DEBT.md`.

---

## Audit findings (2026-10-02)

- *Context archived 2026-10-20: [docs/TODO-ARCHIVE-2026-Q4.md](docs/TODO-ARCHIVE-2026-Q4.md#audit-findings-2026-10-02)*

- *4 closed items archived (last 2026-10-20): [docs/TODO-ARCHIVE-2026-Q4.md](docs/TODO-ARCHIVE-2026-Q4.md#audit-findings-2026-10-02)*
- [ ] 2026-10-02 Patrick: an EXISTING server container keeps its old 0.0.0.0 binding - run `npm run server:recreate` once (world is kept), then `docker ps` should show `127.0.0.1:25565->25565`.
- [ ] medium - In-game `!build` still has no sender allowlist (`src/index.js`) - accept only `MC_OWNER`/listed names; needs a decision on the default (owner unknown in offline mode).
- [ ] medium - Per-session spend cap on model calls (audit improvement, effort M).

## Refactor audit (2026-10-01) - found, not started

- *Context archived 2026-10-20: [docs/TODO-ARCHIVE-2026-Q4.md](docs/TODO-ARCHIVE-2026-Q4.md#refactor-audit-2026-10-01-found-not-started)*

- [ ] 🟡 `scripts/web.js` (1,701 lines; l.1133-1701 is one `PAGE` template string) -> `public/index.html` + `src/scene/`. M, low-med (`npm run record` uses it).
- *1 closed item archived (last 2026-10-20): [docs/TODO-ARCHIVE-2026-Q4.md](docs/TODO-ARCHIVE-2026-Q4.md#refactor-audit-2026-10-01-found-not-started)*
- [ ] No turn has been played on `gpt-6-luna` (needs an OpenAI key): run one build with `LLM_PROVIDER=openai` and confirm the JSON plan parses.

## Open

- [ ] Consider giving the critic more than one round (it currently critiques once and applies one patch). Worth it only if the single pass proves to help - measure before adding cost.
- *2 closed items archived (last 2026-10-20): [docs/TODO-ARCHIVE-2026-Q4.md](docs/TODO-ARCHIVE-2026-Q4.md#open)*
- [ ] 🟠 **Stray mason blocks land on the roof slope.** The critic caught it unprompted on the live
      run ("stray stone brick blocks on the northwest slope, interrupting the wooden roofline", 8/10)
      and it is visible in the screenshots as pale specks across the shingles. Likely the mason's
      `cyl` running past the eaves into the carpenter's cone. Worth reproducing on the preset
      simulator, which already models exactly this class of cross-role overwrite.
- [ ] `npm run record` doesn't know about the review phase - a recorded clip cuts at "build done" and would miss a critic patch landing. Fine today (the recorder builds presets, which are never reviewed), but wire it up if the hero clip ever uses a prompt build with `CRITIC=on`.
- [ ] Decide whether the other scenes should also lose their sheer platform edges (a sloped grass/stone skirt would work the same way as the beach apron; only Beach has `shore: true` today).
- [ ] Consider surfacing the placement marker for the AI path too - right now a hand-placed spot is consumed by one build; a "keep this spot" toggle would let you stack several builds on one plot deliberately.
- [ ] Verify one live Claude and OpenAI build once keys are available. The code paths have still
      never been exercised against the real APIs, but they are no longer *wrong*: the Claude pin
      moved off a deprecated model to `claude-opus-5`, text extraction is block-type-aware (thinking
      is on by default there, so `content[0]` is not the answer), and both providers now name a
      truncation as a truncation. See the Done entry below. **Decision 2026-07-30: NOT a launch
      blocker** - the owner doesn't use paid keys, so this ships as-is with honest labeling instead
      (README note + docs/SETUP.md "battle-tested note": Gemini has the live mileage, Claude/OpenAI
      are test-pinned, please file issues). First real-world exercise will come from users.
- [ ] Consider a hand-driven OBS capture of the hero clip if even higher fidelity is wanted - `npm run record` is headless (software-rendered), so the grass texture carries some compression noise at 800px.
- [ ] Consider a shareable/hosted-tunnel option (e.g. one-liner to expose the local viewer) - only if there's real demand; keeps the "100% local" promise by default.
- [ ] Draft launch post (HN / Reddit r/Minecraft+r/programming / X) - the demo clip now exists.
