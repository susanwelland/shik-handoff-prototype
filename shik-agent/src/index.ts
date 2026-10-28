// shik-agent — entrypoint. Reads config from the environment (systemd-friendly),
// starts the daemon, and shuts down cleanly so SHIK's presence record is closed
// and the kernel is flushed to disk on power-down.
import { ShikAgent, AgentConfig } from './agent.js';

const cfg: AgentConfig = {
  agentId: process.env.SHIK_AGENT_ID || 'did:shik:pi-01',
  bodyId: process.env.SHIK_BODY_ID || 'shik-pi-01',
  bodyName: process.env.SHIK_BODY_NAME || 'the Pi on the shelf',
  statePath: process.env.SHIK_STATE_PATH || './data/kernel.json',
  mindUrl: process.env.SHIK_MIND_URL || 'http://localhost:3000/api/cognition',
  kernelPort: Number(process.env.SHIK_KERNEL_PORT || 8137),
  cognitionEngine: process.env.SHIK_COGNITION_ENGINE || 'swappable mind (SHIK_MIND_URL)',
};

const agent = new ShikAgent(cfg);

async function shutdown(signal: string) {
  console.log(`\n[agent] ${signal} — shutting down.`);
  await agent.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

agent.start().catch(err => {
  console.error('[agent] failed to start:', err);
  process.exit(1);
});
