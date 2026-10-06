/**
 * Barge-in detection: tells the caller the moment the user starts talking
 * over the assistant, so a long reply can be cut short instead of having to
 * be sat through.
 *
 * Deliberately a microphone ENERGY meter, not SpeechRecognition. Running
 * recognition while speechSynthesis is playing transcribes the assistant's
 * own voice and re-sends it as the next question, which loops forever (see
 * AiChatPage's startVoiceTurn). This never produces text — it only answers
 * "is someone talking?" — so the worst it can do when it is wrong is end a
 * reply early. The real recognition turn still starts only after playback has
 * been cancelled.
 *
 * Echo from the assistant's own playback is handled in three layers:
 *   1. getUserMedia's echoCancellation, which removes most of what the
 *      speakers are playing from the mic signal;
 *   2. a noise floor measured live during `graceMs` (which also covers the
 *      start of playback, when leakage is loudest) and a margin above it, so
 *      whatever echo survives still has to be beaten;
 *   3. `sustainMs` of continuous sound, so a cough, a keyboard or one echoed
 *      syllable doesn't count as the user taking over.
 */

export interface VoiceActivityOptions {
  /** Fired once, when the user is judged to have started speaking. The
   *  detector stops itself immediately before calling this. */
  onSpeechStart: () => void;
  /** Ignore everything for this long after start(), while the noise floor is
   *  measured. Also covers the loudest part of the assistant's own onset. */
  graceMs?: number;
  /** How long sound must stay above the threshold to count as speech. */
  sustainMs?: number;
  /** How far above the measured noise floor sound has to be, in dB. */
  marginDb?: number;
}

/** Stops the detector and releases the microphone. Safe to call twice. */
export type StopVoiceActivity = () => void;

const FRAME_MS = 50;
const DEFAULT_GRACE_MS = 400;
const DEFAULT_SUSTAIN_MS = 300;
const DEFAULT_MARGIN_DB = 12;

/** Nothing quieter than this counts as speech however quiet the room is —
 *  without it, a silent room measures a noise floor so low that the margin
 *  alone is cleared by the assistant's own faint echo. */
const ABSOLUTE_FLOOR_DB = -45;

/** Guards log10(0) when a frame is digital silence. */
const SILENCE_DB = -100;

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as any).webkitAudioContext;
}

/** True when this browser can do barge-in at all. */
export function canDetectVoiceActivity(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!audioContextCtor()
  );
}

function frameDb(analyser: AnalyserNode, buffer: Float32Array): number {
  analyser.getFloatTimeDomainData(buffer as any);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  const rms = Math.sqrt(sum / buffer.length);
  return rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB;
}

/**
 * Starts listening for the user talking. Resolves with a stop function once
 * the microphone is open, or with a no-op if barge-in isn't possible here
 * (unsupported browser, denied permission) — callers treat that as "no
 * barge-in" rather than an error, since the tap-to-interrupt button still
 * works either way.
 */
export async function detectVoiceActivity(options: VoiceActivityOptions): Promise<StopVoiceActivity> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const sustainMs = options.sustainMs ?? DEFAULT_SUSTAIN_MS;
  const marginDb = options.marginDb ?? DEFAULT_MARGIN_DB;

  const Ctor = audioContextCtor();
  if (!canDetectVoiceActivity() || !Ctor) return () => {};

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // echoCancellation is what keeps the assistant's own playback out of
      // this signal; the other two keep a noisy room from reading as speech.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return () => {};
  }

  const context = new Ctor();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let elapsedMs = 0;
  let loudMs = 0;
  let noiseFloorDb = SILENCE_DB;

  const stop: StopVoiceActivity = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    try {
      source.disconnect();
    } catch {
      /* already torn down */
    }
    // Release the microphone: leaving tracks live keeps the recording
    // indicator on and can stop SpeechRecognition from acquiring the device
    // for the turn that is about to start.
    stream.getTracks().forEach((track) => track.stop());
    void context.close?.();
  };

  timer = setInterval(() => {
    if (stopped) return;
    elapsedMs += FRAME_MS;
    const db = frameDb(analyser, buffer);

    if (elapsedMs <= graceMs) {
      // Calibrating: take the loudest frame seen, so the floor accounts for
      // whatever echo is getting through rather than the quietest moment.
      noiseFloorDb = Math.max(noiseFloorDb, db);
      return;
    }

    const threshold = Math.max(noiseFloorDb + marginDb, ABSOLUTE_FLOOR_DB);
    if (db >= threshold) {
      loudMs += FRAME_MS;
      if (loudMs >= sustainMs) {
        stop();
        options.onSpeechStart();
      }
    } else {
      // Must be continuous — a gap resets it, so one loud syllable of echo
      // never accumulates into a barge-in across a whole reply.
      loudMs = 0;
    }
  }, FRAME_MS);

  return stop;
}
