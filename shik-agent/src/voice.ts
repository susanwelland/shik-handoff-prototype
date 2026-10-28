// shik-agent — on-device voice I/O for the Pi body (vendor-free).
// Hearing and speech are commodity I/O, not cognition. On the Pi they run
// locally: whisper.cpp for speech-to-text, piper for text-to-speech. Both are
// invoked as external binaries so the daemon has no model SDK dependency and
// the ears/mouth are swappable independently of the mind (SHIK_MIND_URL).
//
// This adapter shells out when the binaries are present and degrades to a
// no-op (log only) when they are not, so the daemon runs everywhere.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface VoiceIO {
  readonly label: string;
  /** Transcribe a 16 kHz mono WAV file to text. */
  transcribe(wavPath: string): Promise<string>;
  /** Synthesize text to a WAV file and return its path. */
  synthesize(text: string, outPath: string): Promise<string | null>;
}

export interface ShellVoiceConfig {
  whisperBin?: string;   // e.g. /opt/whisper.cpp/main
  whisperModel?: string; // e.g. /opt/whisper.cpp/models/ggml-base.en.bin
  piperBin?: string;     // e.g. /opt/piper/piper
  piperVoice?: string;   // e.g. /opt/piper/voices/en_US-lessac-medium.onnx
}

export class ShellVoice implements VoiceIO {
  readonly label: string;
  constructor(private cfg: ShellVoiceConfig) {
    const stt = cfg.whisperBin && existsSync(cfg.whisperBin) ? 'whisper.cpp' : 'no-stt';
    const tts = cfg.piperBin && existsSync(cfg.piperBin) ? 'piper' : 'no-tts';
    this.label = `${stt} + ${tts}`;
  }

  async transcribe(wavPath: string): Promise<string> {
    const { whisperBin, whisperModel } = this.cfg;
    if (!whisperBin || !whisperModel || !existsSync(whisperBin)) return '';
    // whisper.cpp prints the transcript to stdout with -nt (no timestamps).
    const { stdout } = await run(whisperBin, ['-m', whisperModel, '-f', wavPath, '-nt', '-np']);
    return stdout.trim();
  }

  async synthesize(text: string, outPath: string): Promise<string | null> {
    const { piperBin, piperVoice } = this.cfg;
    if (!piperBin || !piperVoice || !existsSync(piperBin)) {
      console.log(`[voice:tts-unavailable] ${text}`);
      return null;
    }
    // piper reads text on stdin and writes a WAV to --output_file.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(piperBin, ['--model', piperVoice, '--output_file', outPath], err => (err ? reject(err) : resolve()));
      child.stdin?.end(text);
    });
    return outPath;
  }
}

export function voiceFromEnv(): ShellVoice {
  return new ShellVoice({
    whisperBin: process.env.SHIK_WHISPER_BIN,
    whisperModel: process.env.SHIK_WHISPER_MODEL,
    piperBin: process.env.SHIK_PIPER_BIN,
    piperVoice: process.env.SHIK_PIPER_VOICE,
  });
}
