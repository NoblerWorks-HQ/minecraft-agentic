#!/usr/bin/env node
// Friendly one-shot onboarding: `npm run setup`.
// Checks Node, creates .env from the example, and tells you exactly what's left.
// Pure Node - no dependencies, safe to run before `npm install` finishes.
import fs from 'fs';
import path from 'path';
import net from 'net';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

const ok = [];
const todo = [];

console.log(b('\n  Minecraft Agentic Builder - setup check\n'));

// 1. Node version
const major = parseInt(process.versions.node.split('.')[0], 10);
// 22 is the floor in package.json engines, and the oldest version CI proves green.
if (major >= 22) ok.push(`Node ${process.versions.node}`);
else todo.push(`Node ${process.versions.node} is too old - install Node 22+ (nodejs.org; 24 recommended)`);

// 2. .env
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');
if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log(`  ${g('created')} .env from .env.example`);
  }
}
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const keyMatch = env.match(/^ANTHROPIC_API_KEY=(.*)$/m);
const key = keyMatch ? keyMatch[1].trim() : '';
if (key && key !== 'your-api-key-here') ok.push('ANTHROPIC_API_KEY is set');
else todo.push(`Add your Claude API key to .env  (${y('ANTHROPIC_API_KEY=sk-ant-...')})  - get one at console.anthropic.com`);

// 3. Docker (optional but recommended)
let hasDocker = false;
try { execSync('docker info', { stdio: 'ignore' }); hasDocker = true; ok.push('Docker is running'); }
catch { todo.push('Docker not detected - install Docker Desktop, or run your own 1.20.1 server (see docs/SETUP.md)'); }

// 4. Is a server already up?
const serverUp = await new Promise((resolve) => {
  const s = new net.Socket();
  s.setTimeout(2000);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(false));
  s.connect(parseInt(process.env.MC_PORT || '25565', 10), process.env.MC_HOST || 'localhost');
});
if (serverUp) ok.push('Minecraft server reachable on 25565');

// Report
if (ok.length) {
  console.log(b('\n  Ready:'));
  for (const o of ok) console.log(`    ${g('✔')} ${o}`);
}
if (todo.length) {
  console.log(b('\n  Still to do:'));
  for (const t of todo) console.log(`    ${r('•')} ${t}`);
}

// Next step
console.log(b('\n  Next:'));
if (!serverUp && hasDocker) console.log(`    1. Start the server:   ${y('npm run server')}   (then ${y('npm run server:logs')} - wait for "Done!")`);
if (key && key !== 'your-api-key-here') console.log(`    2. Build something:    ${y('npm run crew "a cozy tavern"')}`);
else console.log(`    2. Add your API key to .env, then:  ${y('npm run crew "a cozy tavern"')}`);
console.log(`    3. Watch in browser:   ${y('http://localhost:3000')}`);
console.log(`\n  No key/server yet? Try  ${y('npm run offline')}  for a taste.\n`);
