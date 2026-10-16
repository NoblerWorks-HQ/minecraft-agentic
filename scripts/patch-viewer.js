// Fix two prismarine-viewer bugs in the installed package.
//
// 1. "Stairs are air": viewer/lib/models.js (and its webpack bundle public/worker.js, which
// is what the BROWSER actually runs) skips model lookup for any block whose name contains
// the substring "air" - meant for air/cave_air/void_air, but "stAIRs" matches too, so every
// stair block in the game meshes to zero geometry and simply does not exist in the browser
// view. That is why a finished cottage rendered as a roofless shell with its slab ridge
// floating in mid-air (slabs render; the stairs under them don't), and why the castle's
// tower cones showed as floating apex caps. The world was always right; the picture wasn't.
// Found 2026-07-13.
//
// 2. "The perimeter pops": worldrenderer.js (bundled into public/index.js) DELETES a chunk
// column's meshes the instant the column leaves the camera's radius, and DROPS finished
// geometry whose column unloaded while the mesh job was in flight (remove old mesh -> check
// loadedChunks -> return; the frozen-section bug). Every build start hops the camera bot one
// grid cell, which slides the render radius: a 17-column strip at the trailing edge vanishes
// on the spot and the leading edge re-meshes in over a second or two - in the browser, the
// plot's perimeter (shore, water band, horizon) blinks out and pops back at every build.
// Measured 2026-07-14 by tapping the viewer socket: one aimCamera hop = 17 unloadChunks.
// Our world is static except where the crew is building, so the STALE mesh of an out-of-range
// column is the correct picture of it - keep it (it is refreshed the moment the column comes
// back in range), and always apply late geometry instead of stranding a hole. Memory stays
// bounded: the scene plots are finite and a session revisits the same chunks.
//
// 3. "Listens on all interfaces": prismarine-viewer's http.listen(port) binds 0.0.0.0, so anyone
// on the LAN could open the world view. Bound to 127.0.0.1 (2026-10-16); nothing here reaches it
// from another host (src/viewer.js hands out 127.0.0.1 URLs).
//
// Patching the installed files is the only option: the browser loads the PREBUILT bundle,
// so fixing the source alone changes nothing. Idempotent - safe to run any number of times.
// Wired into `postinstall` (fresh installs) AND called from src/viewer.js at startup
// (existing installs, and belt-and-suspenders if npm ever reinstalls the package).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

export function patchViewer({ quiet = false } = {}) {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('prismarine-viewer/package.json'));
  } catch {
    return { patched: 0, ok: false, reason: 'prismarine-viewer not installed' };
  }

  const targets = [
    {
      file: path.join(pkgDir, 'viewer/lib/models.js'),
      from: /(\w+)\.name\.includes\('air'\)/g,
      to: "($1.name === 'air' || $1.name.endsWith('_air'))",
    },
    {
      file: path.join(pkgDir, 'public/worker.js'),
      from: /(\w+)\.name\.includes\("air"\)/g,
      to: '($1.name==="air"||$1.name.endsWith("_air"))',
    },
    {
      // the main-thread bundle carries the same mesher for the primitives path
      file: path.join(pkgDir, 'public/index.js'),
      from: /(\w+)\.name\.includes\("air"\)/g,
      to: '($1.name==="air"||$1.name.endsWith("_air"))',
    },

    // --- perimeter-pop fixes (worldrenderer): keep stale meshes, apply late geometry ---
    {
      // removeColumn: stop deleting the column's meshes when it leaves the radius. The
      // setSectionDirty(pos, false) cancellations stay; only the scene.remove/dispose goes.
      label: 'keep stale meshes on unload (source)',
      file: path.join(pkgDir, 'viewer/lib/worldrenderer.js'),
      from: /      this\.setSectionDirty\(new Vec3\(x, y, z\), false\)\n      const key = `\$\{x\},\$\{y\},\$\{z\}`\n      const mesh = this\.sectionMeshs\[key\]\n      if \(mesh\) \{\n        this\.scene\.remove\(mesh\)\n        dispose3\(mesh\)\n      \}\n      delete this\.sectionMeshs\[key\]\n/,
      to: '      this.setSectionDirty(new Vec3(x, y, z), false)\n      // patched: keep the stale mesh - the world out of range is static, and the mesh is\n      // replaced the moment the column re-enters the radius (addColumn re-dirties it)\n',
    },
    {
      // geometry handler: don't drop a finished mesh because its column unloaded mid-job -
      // the old mesh was already removed, so dropping strands a hole (the frozen-section bug)
      label: 'apply late geometry (source)',
      file: path.join(pkgDir, 'viewer/lib/worldrenderer.js'),
      from: /          const chunkCoords = data\.key\.split\(','\)\n          if \(!this\.loadedChunks\[chunkCoords\[0\] \+ ',' \+ chunkCoords\[2\]\]\) return\n\n/,
      to: '          // patched: always apply finished geometry - it was meshed from valid data\n',
    },
    {
      label: 'keep stale meshes on unload (bundle)',
      file: path.join(pkgDir, 'public/index.js'),
      from: /;const (\w+)=`\$\{(\w+)\},\$\{(\w+)\},\$\{(\w+)\}`,(\w+)=this\.sectionMeshs\[\1\];\5&&\(this\.scene\.remove\(\5\),(\w+)\(\5\)\),delete this\.sectionMeshs\[\1\]\}/,
      to: '}',
    },
    {
      label: 'apply late geometry (bundle)',
      file: path.join(pkgDir, 'public/index.js'),
      from: /const (\w+)=(\w+)\.key\.split\(","\);if\(!this\.loadedChunks\[\1\[0\]\+","\+\1\[2\]\]\)return;/,
      to: '',
    },

    // --- loopback bind (3): the viewer is a local read-only view, not a LAN service ---
    {
      label: 'bind viewer to 127.0.0.1',
      file: path.join(pkgDir, 'lib/mineflayer.js'),
      from: /http\.listen\(port, \(\) => \{/,
      to: "http.listen(port, '127.0.0.1', () => {",
    },
  ];

  let patched = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;
    const src = fs.readFileSync(t.file, 'utf8');
    if (!t.from.test(src)) continue;   // already patched (or upstream fixed it)
    fs.writeFileSync(t.file, src.replace(t.from, t.to.includes('$1')
      ? (m, v) => t.to.replace(/\$1/g, v)
      : t.to));
    patched++;
    if (!quiet) console.log(`[patch-viewer] ${t.label || 'fixed stairs-are-air'} in ${path.relative(pkgDir, t.file)}`);
  }
  return { patched, ok: true };
}

// Verify mode for tests: exit 1 if the installed files still carry either bug.
export function checkViewer() {
  const pkgDir = path.dirname(require.resolve('prismarine-viewer/package.json'));
  const bad = [];
  for (const rel of ['viewer/lib/models.js', 'public/worker.js', 'public/index.js']) {
    const f = path.join(pkgDir, rel);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/\w+\.name\.includes\(['"]air['"]\)/.test(src)) bad.push(`${rel} (stairs-are-air)`);
  }
  for (const rel of ['viewer/lib/worldrenderer.js', 'public/index.js']) {
    const f = path.join(pkgDir, rel);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    // either the unload-time mesh delete or the late-geometry drop still present
    if (/setSectionDirty\([^)]*, ?(false|!1)\)[\s\S]{0,200}?this\.scene\.remove/.test(src)
      || /key\.split\(['"],['"]\);?\s*if ?\(!this\.loadedChunks\[/.test(src)) {
      bad.push(`${rel} (perimeter-pop)`);
    }
  }
  const mf = path.join(pkgDir, 'lib/mineflayer.js');
  if (fs.existsSync(mf) && /http\.listen\(port, \(\) => \{/.test(fs.readFileSync(mf, 'utf8'))) {
    bad.push('lib/mineflayer.js (viewer listens on all interfaces)');
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const bad = checkViewer();
    if (bad.length) {
      console.error(`[patch-viewer] UNPATCHED - stairs will be invisible in the browser: ${bad.join(', ')}`);
      console.error('[patch-viewer] run: node scripts/patch-viewer.js');
      process.exit(1);
    }
    console.log('[patch-viewer] ok - stairs render in the browser view');
  } else {
    const res = patchViewer();
    if (!res.ok) { console.error(`[patch-viewer] ${res.reason}`); process.exit(1); }
    console.log(res.patched ? `[patch-viewer] patched ${res.patched} file(s)` : '[patch-viewer] already patched - nothing to do');
  }
}
