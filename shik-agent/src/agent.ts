// shik-agent — the daemon. Boots SHIK into a physical body and runs the
// perceive → cognize → act → persist loop. This is the SHIK thesis embodied:
// identity lives locally (KernelStore), reasoning is outsourced through the
// standard interface (CognitionClient), and the body is swappable hardware.
import { KernelStore } from './kernel-store.js';
import { KernelServer } from './kernel-server.js';
import { CognitionClient } from './cognition-client.js';
import { Body, createBody } from './hardware.js';
import { EmbodimentManifest, PerceptInput, PresenceIntent } from './types.js';

export interface AgentConfig {
  agentId: string;
  bodyId: string;
  bodyName: string;
  statePath: string;
  mindUrl: string;
  kernelPort: number;
  cognitionEngine: string;
}

function manifest(cfg: AgentConfig): EmbodimentManifest {
  return {
    bodyId: cfg.bodyId,
    kind: 'raspberry-pi',
    displayName: cfg.bodyName,
    cognitionEngine: cfg.cognitionEngine,
    active: true,
    sensors: [
      { kind: 'audio', label: 'ReSpeaker 2-Mic', available: true },
      { kind: 'vision', label: 'Pi Camera 3', available: false },
      { kind: 'battery', label: 'Power/thermal', available: true },
    ],
    actuators: [
      { kind: 'speak', label: 'I2S speaker (TTS)', available: true },
      { kind: 'light', label: 'RGB LED ring', available: true },
      { kind: 'display', label: 'e-ink / LCD', available: false },
    ],
  };
}

export class ShikAgent {
  private store: KernelStore;
  private kernelServer: KernelServer;
  private mind: CognitionClient;
  private body: Body | null = null;
  private lastAgentText = '';

  constructor(private cfg: AgentConfig) {
    this.store = new KernelStore(cfg.statePath, cfg.agentId);
    this.kernelServer = new KernelServer(this.store, cfg.kernelPort);
    this.mind = new CognitionClient(cfg.mindUrl);
  }

  async start() {
    // 1. Boot & bind: identity comes up locally, presence is recorded.
    this.kernelServer.start();
    this.store.enterBody(this.cfg.bodyId, this.cfg.bodyName);
    this.store.logEvent('bound', `SHIK embodied in ${this.cfg.bodyName}`);
    const m = manifest(this.cfg);
    console.log(`[agent] I am SHIK (${this.cfg.agentId}). I have woken up in ${this.cfg.bodyName}.`);
    console.log(`[agent] I remember ${this.store.get().coreMemories.length} things. Mind: ${this.cfg.mindUrl}`);

    // 2. Bind the body and start perceiving.
    this.body = await createBody(this.cfg.bodyId);
    await this.signal('listening');
    await this.body.perceive(p => this.onPercept(p));
  }

  private async signal(intent: PresenceIntent) {
    await this.body?.signal(intent);
  }

  // 3. Each meaningful percept drives a cognition turn.
  private async onPercept(p: PerceptInput) {
    if (p.kind !== 'speech' || !p.final) return; // health/sensor percepts: log only (kept lean here)
    const userText = p.text;
    this.store.storeContext(userText.slice(0, 120), 'voice');
    await this.signal('thinking');

    const s = this.store.get();
    const delta = await this.mind.reflect({
      userText,
      agentText: this.lastAgentText,
      currentMemories: s.coreMemories.map(x => x.content),
      currentContext: s.sessionContext.map(x => x.content),
      bodyName: this.cfg.bodyName,
    });

    // 4. Persist kernel updates locally first (survives power loss).
    const applied = this.store.applyDelta(delta);
    if (applied.length) console.log(`[kernel] +${applied.length} memory(ies)`);
    if (delta.selfReflection) console.log(`[self] “${delta.selfReflection}”`);

    // Speak: the body's TTS renders what the mind chose to say.
    if (delta.reply) {
      this.lastAgentText = delta.reply;
      await this.signal('speaking');
      await this.body?.act({ kind: 'speak', text: delta.reply, id: '', at: Date.now(), bodyId: this.cfg.bodyId });
    }

    // 5. Render the mind's non-speech actions through the body.
    for (const a of delta.actions || []) {
      if (a.kind === 'light' && a.intent) await this.body?.act({ kind: 'light', intent: a.intent as PresenceIntent, id: '', at: Date.now(), bodyId: this.cfg.bodyId });
      else if (a.kind === 'display' && a.text) await this.body?.act({ kind: 'display', text: a.text, id: '', at: Date.now(), bodyId: this.cfg.bodyId });
      else if (a.kind === 'notify' && a.text) await this.body?.act({ kind: 'notify', text: a.text, id: '', at: Date.now(), bodyId: this.cfg.bodyId });
    }
    await this.signal('listening');
  }

  async stop() {
    await this.signal('idle');
    this.store.leaveBody();
    this.store.logEvent('unbound', `SHIK left ${this.cfg.bodyName}`);
    await this.body?.stop();
    this.kernelServer.stop();
    console.log('[agent] SHIK has left this body. Identity preserved on disk.');
  }
}
