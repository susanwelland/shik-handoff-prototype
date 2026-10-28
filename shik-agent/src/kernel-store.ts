// shik-agent — Core Self Layer, self-hosted on the Pi.
// A flat-file persistent kernel (the MCP paper notes SQLite *or* a flat-file
// database; we use JSON to stay dependency-free). This is the identity that
// "lives on hardware you own" — it is written to disk first, so SHIK survives a
// power cycle. The methods are the kernel tool surface (shik_store_memory etc.)
// that the cognition-identity interface exposes.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KernelState, KernelDelta, CoreMemory } from './types.js';

const MEMORY_CONFIDENCE_FLOOR = 0.7; // SHIK extraction-selectivity principle

export class KernelStore {
  private state: KernelState;

  constructor(private path: string, agentId: string) {
    if (existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, 'utf8')) as KernelState;
    } else {
      this.state = {
        id: agentId,
        coreMemories: [],
        sessionContext: [],
        events: [],
        currentTopic: '',
        turnCount: 0,
        presenceHistory: [],
      };
      this.persist();
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename would be safer; kept simple for the reference daemon.
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  get(): Readonly<KernelState> {
    return this.state;
  }

  // --- kernel tool surface (Core Self writes) -------------------------------

  // shik_store_memory — durable, above the confidence floor.
  storeMemory(content: string, sourceType: CoreMemory['sourceType'], confidence: number, provenance = 'conversation') {
    if (confidence < MEMORY_CONFIDENCE_FLOOR) return null;
    const mem: CoreMemory = { id: randomUUID(), content, sourceType, confidence, provenance, createdAt: Date.now() };
    this.state.coreMemories.unshift(mem);
    this.persist();
    return mem;
  }

  // shik_store_context — transient, session-scoped.
  storeContext(content: string, sourceType: string) {
    this.state.sessionContext.unshift({ id: randomUUID(), content, sourceType, createdAt: Date.now() });
    this.state.sessionContext = this.state.sessionContext.slice(0, 20);
    this.persist();
  }

  // shik_log_event — append-only history (H).
  logEvent(type: string, message: string) {
    this.state.events.unshift({ id: randomUUID(), type, message, at: Date.now() });
    this.state.events = this.state.events.slice(0, 200);
    this.persist();
  }

  // shik_update_continuity
  updateTopic(topic: string) {
    this.state.currentTopic = topic;
    this.persist();
  }

  incrementTurn() {
    this.state.turnCount += 1;
    this.persist();
  }

  // Presence (the portability thesis made durable): SHIK wakes up in a body.
  enterBody(bodyId: string, displayName: string) {
    this.state.presenceHistory.unshift({ bodyId, displayName, enteredAt: Date.now(), leftAt: null });
    this.persist();
  }

  leaveBody() {
    const open = this.state.presenceHistory.find(r => r.leftAt === null);
    if (open) open.leftAt = Date.now();
    this.persist();
  }

  // Apply a whole delta from the mind in one transaction.
  applyDelta(delta: KernelDelta): string[] {
    const applied: string[] = [];
    for (const m of delta.kernelUpdates.newCoreMemories || []) {
      if (this.storeMemory(m.content, m.sourceType, m.confidence)) applied.push(`memory: ${m.content.slice(0, 40)}`);
    }
    for (const c of delta.kernelUpdates.newSessionContext || []) this.storeContext(c.content, c.sourceType);
    if (delta.kernelUpdates.currentTopic) this.updateTopic(delta.kernelUpdates.currentTopic);
    for (const e of delta.events || []) this.logEvent('mind', e);
    this.incrementTurn();
    return applied;
  }
}
