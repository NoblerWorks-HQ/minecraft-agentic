import 'dotenv/config';
import { createBot, waitForSpawn } from './bot.js';
import { Builder } from './builder.js';
import { BuilderAgent } from './agent.js';
import { attachViewer } from './viewer.js';
import { requireApiKey, requireMinecraftServer } from './preflight.js';
import readline from 'readline';

async function main() {
  console.log('=== Minecraft Agentic Builder ===\n');

  // Fail fast with friendly guidance if the key or server is missing
  requireApiKey();
  await requireMinecraftServer();

  // Create the bot
  const bot = createBot({
    username: process.env.MC_USERNAME || 'AgentBuilder'
  });

  const builder = new Builder(bot);
  const agent = new BuilderAgent(process.env.ANTHROPIC_API_KEY);

  // Wait for bot to spawn
  console.log('Connecting to server...');
  await waitForSpawn(bot);
  await builder.init();

  // Open the browser viewer so you can watch without the Minecraft game
  await attachViewer(bot);

  console.log('Bot ready! Enter build prompts:\n');

  // Set up chat listener for in-game commands
  let chatBuildBusy = false;
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    if (message.startsWith('!build ')) {
      const prompt = message.slice(7);
      // One build at a time: each !build is a paid model call plus a /setblock stream.
      if (chatBuildBusy) { bot.chat('Busy - finish or !stop the current build first.'); return; }
      chatBuildBusy = true;
      console.log(`[Chat] ${username} requested: ${prompt}`);
      bot.chat(`On it! Building: ${prompt}`);

      try {
        const pos = bot.entity.position;
        const plan = await agent.generateBuildPlan(prompt, {
          originX: Math.floor(pos.x) + 5,
          originY: Math.floor(pos.y),
          originZ: Math.floor(pos.z) + 5
        });

        // Narrate while building
        for (let i = 0; i < plan.narration.length; i++) {
          setTimeout(() => bot.chat(plan.narration[i]), i * 3000);
        }

        await builder.buildStructure(plan.blocks);
        bot.chat(`Done! Built ${plan.name} with ${plan.blocks.length} blocks.`);
      } catch (err) {
        bot.chat(`Oops, something went wrong: ${err.message}`);
        console.error(err);
      } finally {
        chatBuildBusy = false;
      }
    }

    if (message.startsWith('!stop')) {
      builder.stop();
      bot.chat('Stopping build!');
    }
  });

  // CLI interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === 'quit' || trimmed === 'exit') {
      bot.quit();
      process.exit(0);
    }

    if (trimmed === 'pos') {
      const pos = bot.entity.position;
      console.log(`Position: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`);
      return;
    }

    if (trimmed.startsWith('tp ')) {
      const [, x, y, z] = trimmed.split(' ');
      bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
      return;
    }

    // Treat as build prompt
    try {
      const pos = bot.entity.position;
      const plan = await agent.generateBuildPlan(trimmed, {
        originX: Math.floor(pos.x) + 5,
        originY: Math.floor(pos.y),
        originZ: Math.floor(pos.z) + 5
      });

      bot.chat(`Building: ${plan.name}`);

      // Narrate
      for (let i = 0; i < plan.narration.length; i++) {
        setTimeout(() => bot.chat(plan.narration[i]), i * 3000);
      }

      await builder.buildStructure(plan.blocks);
      bot.chat('Build complete!');
    } catch (err) {
      console.error('Build failed:', err.message);
    }
  });

  console.log('Commands: <build prompt> | pos | tp <x> <y> <z> | quit');
}

main().catch(console.error);
