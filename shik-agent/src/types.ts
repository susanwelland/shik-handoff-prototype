// shik-agent — shared types for the Raspberry Pi body (`shik-pi-01`).
// Mirrors the browser body's contracts (src/lib/embodiment.ts and
// src/lib/kernel-interface.ts) so the SAME SHIK identity can move between
// bodies. Kept self-contained (no imports from the Next.js app) so the daemon
// is an independent, self-hosted process per the SHIK thesis.

export type SensorKind = 'audio' | 'vision' | 'motion' | 'light_level' | 'temperature' | 'battery' | 'touch';
export type ActuatorKind = 'speak' | 'display' | 'light' | 'move' | 'notify';
export type PresenceIntent = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert';

export interface EmbodimentManifest {
  bodyId: string;
  kind: 'raspberry-pi';
  displayName: string;
  sensors: { kind: SensorKind; label: string; available: boolean }[];
  actuators: { kind: ActuatorKind; label: string; available: boolean }[];
  cognitionEngine: string;
  active: boolean;
}

// ---- Perception Bus (senses in) -------------------------------------------
export interface PerceptSource {
  bodyId: string;
  sensor: SensorKind;
  origin: 'human' | 'environment' | 'system';
}
// Distributes across the discriminated union (plain Omit collapses it).
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

interface PerceptBase { id: string; at: number; source: PerceptSource }
export type Percept =
  | (PerceptBase & { kind: 'speech'; text: string; final: boolean })
  | (PerceptBase & { kind: 'vision'; caption?: string })
  | (PerceptBase & { kind: 'motion'; present: boolean })
  | (PerceptBase & { kind: 'light_level'; lux: number })
  | (PerceptBase & { kind: 'temperature'; celsius: number })
  | (PerceptBase & { kind: 'battery'; percent: number; charging: boolean })
  | (PerceptBase & { kind: 'touch'; control: string });

export type PerceptInput = DistributiveOmit<Percept, 'id' | 'at'>;

// ---- Action Bus (intent out) ----------------------------------------------
interface ActionBase { id: string; at: number; bodyId: string }
export type Action =
  | (ActionBase & { kind: 'speak'; text: string })
  | (ActionBase & { kind: 'display'; text: string })
  | (ActionBase & { kind: 'light'; intent: PresenceIntent })
  | (ActionBase & { kind: 'move'; gesture: string })
  | (ActionBase & { kind: 'notify'; text: string });

// ---- Kernel (Core Self Layer) ---------------------------------------------
export interface CoreMemory {
  id: string; content: string;
  sourceType: 'voice' | 'visual' | 'inferred';
  provenance: string; confidence: number; createdAt: number;
}
export interface SessionContextEntry { id: string; content: string; sourceType: string; createdAt: number }
export interface KernelEvent { id: string; type: string; message: string; at: number }
export interface PresenceRecord { bodyId: string; displayName: string; enteredAt: number; leftAt: number | null }

// The persistent self-model that survives power cycles and body swaps.
export interface KernelState {
  id: string;                 // stable agent identifier (the SHIK `id`)
  coreMemories: CoreMemory[]; // M
  sessionContext: SessionContextEntry[];
  events: KernelEvent[];      // H (append-only)
  currentTopic: string;
  turnCount: number;
  presenceHistory: PresenceRecord[];
}

// What the mind returns (matches the app's KernelDelta / kernel-interface.ts).
export interface KernelDelta {
  /** What SHIK says aloud this turn (rendered by the body's TTS). */
  reply: string;
  kernelUpdates: {
    newCoreMemories: { content: string; sourceType: 'voice' | 'visual' | 'inferred'; confidence: number }[];
    newSessionContext: { content: string; sourceType: 'voice' | 'visual' | 'inferred' }[];
    currentTopic: string | null;
  };
  selfReflection: string;
  actions: { kind: 'light' | 'display' | 'notify'; intent?: string; text?: string }[];
  events: string[];
}
