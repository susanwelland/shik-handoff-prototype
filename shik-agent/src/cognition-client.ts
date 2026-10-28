// shik-agent — Cognition client (the body's link to a swappable mind).
// The Pi hosts identity; reasoning is outsourced through the SAME standard
// cognition-identity interface the browser body uses. The mind endpoint is a
// single config value (SHIK_MIND_URL) — pointing it at a different model is the
// "swap the model in one config line" guarantee from the MCP paper. No model
// SDK is bundled into the body; the body only speaks the interface.
import { KernelDelta } from './types.js';

const EMPTY: KernelDelta = {
  reply: '',
  kernelUpdates: { newCoreMemories: [], newSessionContext: [], currentTopic: null },
  selfReflection: '',
  actions: [],
  events: [],
};

export interface CognitionTurn {
  userText: string;
  agentText: string;
  currentMemories: string[];
  currentContext: string[];
  bodyName: string;
}

export class CognitionClient {
  constructor(private mindUrl: string) {}

  async reflect(turn: CognitionTurn): Promise<KernelDelta> {
    try {
      const res = await fetch(this.mindUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(turn),
      });
      if (!res.ok) throw new Error(`mind ${res.status}`);
      return (await res.json()) as KernelDelta;
    } catch (e) {
      console.error('[cognition] unreachable — staying present without thinking:', (e as Error).message);
      // The body stays present even when the brain is offline (M4 resilience).
      return EMPTY;
    }
  }
}
