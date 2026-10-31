# Contributing

Thanks for your interest! This project is small and moves fast; the bar for a good PR is
"the tests pass and the invariants survive".

## Getting set up

```sh
npm install        # Node >= 20; postinstall patches prismarine-viewer (required)
npm test           # no browser, no server, no API key needed
```

The full local experience needs Docker (for the Minecraft server): `npm run play`.
See [docs/SETUP.md](docs/SETUP.md) for the walkthrough and troubleshooting.

## Before you open a PR

1. **Run `npm test`.** It needs no server and no key, and CI runs exactly this plus
   `npm audit --audit-level=high` on Node 22 and 24.
2. **Touched `src/library/` or the crew's scheduling?** Run `npm run test:presets` - it
   simulates every preset on the crew's real parallel schedule with vanilla physics
   (neighbor-update pops, gravity, door support). It has caught ~145 silent defects that
   looked fine in a sequential build.
3. **Touched bot connection, block placement, or the viewer?** Run `npm run e2e`
   (single bot) or `npm run replay` (full crew) against a live server - both work with
   no API key. `npm run test:viewer` checks the browser actually sees what the crew built.
4. **Read [CLAUDE.md](CLAUDE.md) for the area you're changing.** It is the project's
   invariant list - every entry is a bug that shipped, how it was found, and the rule that
   keeps it dead. If your change fights one of those rules, the rule usually wins; if the
   rule is wrong, update it in the same PR.

## Ground rules that bite newcomers

- **Silent failure is the house specialty.** `/setblock` discards bad block names without
  a word, `/fill` refuses >32,768 blocks silently, and `bot.chat()` on a disconnected bot
  is a no-op. If your feature "worked" but the world didn't change, start there.
- **Model output is untrusted input.** Anything a model returns (ops, patches, blocks)
  goes through a validating door (`expandOps` / `normalizePatch`) - never straight to the
  server. New model-facing surface needs the same treatment.
- **Docs move with code.** If you change behavior, constants, env vars, or commands,
  update the matching section of README / CLAUDE.md / docs/ in the same PR.

## Reporting bugs

Use the issue templates. The single most useful thing you can include is whether
`verifyBuild` reported missing blocks - "the build looks broken in the browser" and
"the build is broken" are usually different bugs here.
