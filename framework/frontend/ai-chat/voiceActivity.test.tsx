/**
 * Barge-in detection. The thing these guard against is a detector that fires
 * on the assistant's own voice leaking into the microphone — that would cut
 * every reply off a few hundred ms in, which is worse than no barge-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectVoiceActivity, canDetectVoiceActivity } from './voiceActivity';

/** Level the fake microphone reports, as a linear RMS amplitude. */
let micLevel = 0;

const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] };
const getUserMedia = vi.fn(async () => stream);

const analyser = {
  fftSize: 1024,
  getFloatTimeDomainData: (buf: Float32Array) => buf.fill(micLevel),
};
const source = { connect: vi.fn(), disconnect: vi.fn() };
const close = vi.fn();

class FakeAudioContext {
  createAnalyser() {
    return analyser;
  }
  createMediaStreamSource() {
    return source;
  }
  close = close;
}

/** dBFS -> linear amplitude, so tests can speak in the units the detector uses. */
const db = (value: number) => 10 ** (value / 20);

const QUIET = db(-70); // a silent room
const ECHO = db(-52); // assistant's voice leaking past echo cancellation
const TALKING = db(-20); // the user

function advance(ms: number) {
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  micLevel = QUIET;
  track.stop.mockClear();
  getUserMedia.mockClear();
  getUserMedia.mockResolvedValue(stream as any);
  close.mockClear();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canDetectVoiceActivity', () => {
  it('is true when the browser has a microphone and Web Audio', () => {
    expect(canDetectVoiceActivity()).toBe(true);
  });

  it('is false without getUserMedia', () => {
    vi.stubGlobal('navigator', {});
    expect(canDetectVoiceActivity()).toBe(false);
  });
});

describe('detectVoiceActivity', () => {
  it('fires once the user has been talking long enough', async () => {
    const onSpeechStart = vi.fn();
    await detectVoiceActivity({ onSpeechStart });

    advance(400); // grace: noise floor measured
    expect(onSpeechStart).not.toHaveBeenCalled();

    micLevel = TALKING;
    advance(300); // sustain
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
  });

  it('does not fire on the assistant\'s own echo, however long the reply runs', async () => {
    const onSpeechStart = vi.fn();
    // Echo is already present while the noise floor is being measured, which
    // is what lifts the threshold above it.
    micLevel = ECHO;
    await detectVoiceActivity({ onSpeechStart });

    advance(400);
    advance(20_000); // a very long reply
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('still hears the user over that echo', async () => {
    const onSpeechStart = vi.fn();
    micLevel = ECHO;
    await detectVoiceActivity({ onSpeechStart });
    advance(400);

    micLevel = TALKING;
    advance(300);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
  });

  it('ignores a short burst - a cough or one echoed syllable', async () => {
    const onSpeechStart = vi.fn();
    await detectVoiceActivity({ onSpeechStart });
    advance(400);

    micLevel = TALKING;
    advance(100); // shorter than sustain
    micLevel = QUIET;
    advance(1000);
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('requires the sound to be continuous, not merely frequent', async () => {
    const onSpeechStart = vi.fn();
    await detectVoiceActivity({ onSpeechStart });
    advance(400);

    for (let i = 0; i < 20; i++) {
      micLevel = TALKING;
      advance(100);
      micLevel = QUIET;
      advance(100);
    }
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('ignores the user talking during the grace period', async () => {
    const onSpeechStart = vi.fn();
    await detectVoiceActivity({ onSpeechStart });

    micLevel = TALKING;
    advance(300); // still inside grace
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('releases the microphone when it fires', async () => {
    await detectVoiceActivity({ onSpeechStart: vi.fn() });
    advance(400);
    micLevel = TALKING;
    advance(300);
    expect(track.stop).toHaveBeenCalled();
  });

  it('releases the microphone when stopped', async () => {
    const stop = await detectVoiceActivity({ onSpeechStart: vi.fn() });
    stop();
    expect(track.stop).toHaveBeenCalled();
    expect(source.disconnect).toHaveBeenCalled();
  });

  it('never fires after being stopped', async () => {
    const onSpeechStart = vi.fn();
    const stop = await detectVoiceActivity({ onSpeechStart });
    stop();

    micLevel = TALKING;
    advance(5000);
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('is safe to stop twice', async () => {
    const stop = await detectVoiceActivity({ onSpeechStart: vi.fn() });
    stop();
    expect(() => stop()).not.toThrow();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('degrades to no barge-in when the microphone is refused', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    const onSpeechStart = vi.fn();
    const stop = await detectVoiceActivity({ onSpeechStart });

    advance(5000);
    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('asks for echo cancellation, which is what keeps playback out of the signal', async () => {
    await detectVoiceActivity({ onSpeechStart: vi.fn() });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  });
});
