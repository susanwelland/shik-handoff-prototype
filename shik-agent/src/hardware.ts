// shik-agent — Hardware abstraction (the body's senses and actuators).
// The agent NEVER addresses a GPIO pin. It emits abstract intent
// (`light: thinking`) and the Body maps it to hardware. Swapping the LED ring
// for an e-ink face later changes only this file — the agent's vocabulary is
// unchanged. A HeadlessBody runs the whole daemon with no hardware (CI / dev),
// and the real Pi bindings are loaded as OPTIONAL dynamic imports so a missing
// HAT degrades gracefully instead of crashing.
import { PerceptInput, Action, PresenceIntent } from './types.js';

export interface Body {
  /** Start streaming senses; each percept is delivered to `onPercept`. */
  perceive(onPercept: (p: PerceptInput) => void): Promise<void>;
  /** Render an abstract action through the hardware. */
  act(action: Action): Promise<void>;
  /** Express a presence/light intent (drives the LED ring on the real body). */
  signal(intent: PresenceIntent): Promise<void>;
  stop(): Promise<void>;
}

const PRESENCE_COLOR: Record<PresenceIntent, string> = {
  idle: 'dim white', listening: 'green', thinking: 'amber', speaking: 'indigo', alert: 'red',
};

/**
 * Headless body — no hardware required. Mic/camera are simulated; actuators log
 * to stdout. This is what runs in CI and on a dev laptop. It also defines the
 * exact surface the real Pi body must implement.
 */
export class HeadlessBody implements Body {
  private timer: NodeJS.Timeout | null = null;
  constructor(private bodyId: string) {}

  async perceive(onPercept: (p: PerceptInput) => void): Promise<void> {
    // Emit a battery/health percept every 30s so the self-model reflects the
    // body's real condition (on the Pi this reads /sys/class/power_supply + vcgencmd).
    this.timer = setInterval(() => {
      onPercept({ kind: 'battery', percent: 100, charging: true, source: { bodyId: this.bodyId, sensor: 'battery', origin: 'system' } });
    }, 30_000);

    // Bridge stdin → speech percepts so you can "talk" to the headless body.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) onPercept({ kind: 'speech', text, final: true, source: { bodyId: this.bodyId, sensor: 'audio', origin: 'human' } });
    });
  }

  async act(action: Action): Promise<void> {
    switch (action.kind) {
      case 'speak': console.log(`[body:speak] ${action.text}`); break;            // → TTS / I2S speaker
      case 'display': console.log(`[body:display] ${action.text}`); break;         // → e-ink / round LCD
      case 'light': await this.signal(action.intent); break;
      case 'move': console.log(`[body:move] ${action.gesture}`); break;            // → servos
      case 'notify': console.log(`[body:notify] ${action.text}`); break;
    }
  }

  async signal(intent: PresenceIntent): Promise<void> {
    console.log(`[body:led] ${intent} (${PRESENCE_COLOR[intent]})`);               // → WS2812 / ReSpeaker ring
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Factory: returns the real Pi body if its HAT libraries are present, else the
 * headless body. The real implementation (ReSpeaker LEDs, Pi Camera via
 * libcamera, I2S mic/speaker, PIR/BH1750 over I2C) lives in `pi-body.ts` and is
 * loaded dynamically so this daemon installs and runs on any machine.
 */
export async function createBody(bodyId: string): Promise<Body> {
  if (process.env.SHIK_BODY === 'headless') return new HeadlessBody(bodyId);
  try {
    // Optional: only present on a provisioned Pi. Computed specifier so this is
    // not statically resolved at build time (the file may not exist).
    const spec = './pi-body.js';
    const mod = (await import(spec).catch(() => null)) as { PiBody: new (id: string) => Body } | null;
    if (mod?.PiBody) return new mod.PiBody(bodyId);
  } catch {
    /* fall through to headless */
  }
  return new HeadlessBody(bodyId);
}
