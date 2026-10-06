/**
 * Regression tests for the two voice-chat failures:
 *   1. The Voice Chat button needed several clicks before it took — a failing
 *      `recognition.start()` left voice mode switched on with a dead mic, so
 *      the next click only toggled it back off.
 *   2. Navigating away mid-voice-chat broke voice chat until a page reload —
 *      the unmount stop fired `onend`, which restarted recognition after the
 *      page was gone, and that orphan kept holding the microphone.
 *
 * SpeechRecognitionCtor is captured at module load, so the mock has to be on
 * `window` before AiChatPage is imported — hence resetModules + dynamic
 * import in beforeEach rather than a top-level import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type React from 'react';

class MockRecognition {
  static instances: MockRecognition[] = [];
  /** Simulates another recognition already holding the mic: Chrome throws
   *  InvalidStateError synchronously out of `start()`. */
  static failNextStart = false;

  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;

  constructor() {
    MockRecognition.instances.push(this);
  }

  start() {
    if (MockRecognition.failNextStart) {
      MockRecognition.failNextStart = false;
      throw new Error('InvalidStateError: recognition has already started');
    }
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.onend?.();
  }

  abort() {
    const wasStarted = this.started;
    this.aborted = true;
    this.started = false;
    if (wasStarted) this.onend?.();
  }

  /** Test helper: the user said something and Chrome reported it. */
  say(text: string) {
    this.onresult?.({ resultIndex: 0, results: [[{ transcript: text }]] });
  }
}

const sendMessage = vi.fn(async () => ({ success: true, response: 'ok' }) as any);

/** Captures what AiChatPage asks the barge-in detector to do, so a test can
 *  play the part of the user talking over the reply. */
let bargeIn: { onSpeechStart: () => void } | null = null;
const stopBargeIn = vi.fn();
vi.mock('./voiceActivity', () => ({
  canDetectVoiceActivity: () => true,
  detectVoiceActivity: async (options: any) => {
    bargeIn = options;
    return stopBargeIn;
  },
}));

/** When false, the TTS stub holds the utterance open instead of ending it
 *  immediately - i.e. a long reply still playing. */
let autoFinishSpeech = true;

let AiChatPage: React.FC<any>;

function renderPage() {
  return render(
    <MemoryRouter>
      <AiChatPage sendMessage={sendMessage} />
    </MemoryRouter>
  );
}

/** Voice turns start off a timer (Chrome needs the audio device released
 *  first), so every click has to be followed by a timer flush. */
function flushTimers() {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

const voiceButton = () => screen.getByRole('button', { name: /voice chat/i });

beforeEach(async () => {
  vi.useFakeTimers();
  // jsdom has no layout, so no scrollIntoView — the page scrolls to the newest message.
  Element.prototype.scrollIntoView = vi.fn();
  MockRecognition.instances = [];
  MockRecognition.failNextStart = false;
  sendMessage.mockClear();
  bargeIn = null;
  stopBargeIn.mockClear();
  autoFinishSpeech = true;
  vi.stubGlobal('SpeechRecognition', MockRecognition);
  // Finish speaking immediately: the page awaits `speak()` before reopening
  // the mic, so a stub that never fires onend stalls every follow-up turn.
  vi.stubGlobal('speechSynthesis', {
    cancel: vi.fn(),
    resume: vi.fn(),
    speak: vi.fn((u: any) => {
      if (autoFinishSpeech) u.onend?.();
    }),
  });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      onend: any = null;
      onerror: any = null;
      constructor(public text: string) {}
    }
  );
  vi.resetModules();
  AiChatPage = (await import('./AiChatPage')).AiChatPage as React.FC<any>;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AiChatPage voice chat', () => {
  it('starts listening on the first click', () => {
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    expect(MockRecognition.instances).toHaveLength(1);
    expect(MockRecognition.instances[0].started).toBe(true);
    expect(screen.getByRole('button', { name: /listening/i })).toBeInTheDocument();
  });

  it('leaves voice mode (instead of staying lit with a dead mic) when start fails', () => {
    renderPage();
    MockRecognition.failNextStart = true;
    fireEvent.click(voiceButton());
    flushTimers();

    // Button back to the off state, and the failure is surfaced — the old
    // behaviour left it reading "Voice Chat On" so the next click just
    // toggled it off, which is why it took several clicks.
    expect(voiceButton()).toHaveTextContent(/^Voice Chat$/);
    expect(screen.getByText(/could not start the microphone/i)).toBeInTheDocument();
  });

  it('recovers on the very next click after a failed start', () => {
    renderPage();
    MockRecognition.failNextStart = true;
    fireEvent.click(voiceButton());
    flushTimers();

    fireEvent.click(voiceButton());
    flushTimers();

    expect(MockRecognition.instances.at(-1)!.started).toBe(true);
    expect(screen.getByRole('button', { name: /listening/i })).toBeInTheDocument();
  });

  it('drops out of voice mode on a denied microphone instead of looping', () => {
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    const rec = MockRecognition.instances[0];
    act(() => {
      rec.onerror?.({ error: 'not-allowed' });
      rec.stop();
    });
    flushTimers();

    expect(MockRecognition.instances).toHaveLength(1);
    expect(voiceButton()).toHaveTextContent(/^Voice Chat$/);
    expect(screen.getByText(/microphone access is blocked/i)).toBeInTheDocument();
  });

  it('keeps listening through a silent turn', () => {
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    act(() => MockRecognition.instances[0].stop()); // ended with no transcript
    flushTimers();

    expect(MockRecognition.instances).toHaveLength(2);
    expect(MockRecognition.instances[1].started).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends the conversation so far with each follow-up voice turn', async () => {
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    // Turn 1
    await act(async () => {
      MockRecognition.instances[0].say('send Jennifer Crenshaw a notification');
      MockRecognition.instances[0].stop();
    });
    flushTimers();

    // Turn 2 — a follow-up that only makes sense with the first turn in view.
    await act(async () => {
      MockRecognition.instances.at(-1)!.say('her name is spelled with one n');
      MockRecognition.instances.at(-1)!.stop();
    });
    flushTimers();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const [, historyOfSecondTurn] = sendMessage.mock.calls[1];
    expect(historyOfSecondTurn).toEqual([
      { role: 'user', content: 'send Jennifer Crenshaw a notification' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('stops talking and listens when the user talks over a long reply', async () => {
    autoFinishSpeech = false; // the reply is still playing
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    await act(async () => {
      MockRecognition.instances[0].say('what is the status of the Riverside order');
      MockRecognition.instances[0].stop();
    });
    flushTimers();

    const recognitionsBefore = MockRecognition.instances.length;
    expect(bargeIn).not.toBeNull();
    expect(screen.getByRole('button', { name: /speaking/i })).toBeInTheDocument();

    // The user starts talking over it.
    await act(async () => {
      bargeIn!.onSpeechStart();
    });
    flushTimers();

    expect((window.speechSynthesis.cancel as any)).toHaveBeenCalled();
    expect(MockRecognition.instances.length).toBe(recognitionsBefore + 1);
    expect(MockRecognition.instances.at(-1)!.started).toBe(true);
    expect(screen.getByRole('button', { name: /listening/i })).toBeInTheDocument();
  });

  it('does not open the barge-in microphone outside voice mode', async () => {
    autoFinishSpeech = false;
    renderPage();

    // Typed question, voice chat never switched on.
    const input = screen.getByPlaceholderText(/ask a question/i);
    fireEvent.change(input, { target: { value: 'how much is a XL-SB-ECO' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    flushTimers();

    expect(bargeIn).toBeNull();
  });

  it('recovers when the browser never reports the reply finished', async () => {
    // Chrome's synthesis can get wedged and fire neither onend nor onerror.
    // Voice mode awaits speak(), so without a watchdog the conversation stops
    // dead here with no error and no microphone.
    autoFinishSpeech = false;
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    await act(async () => {
      MockRecognition.instances[0].say('what is on order 1234');
      MockRecognition.instances[0].stop();
    });
    flushTimers();

    const recognitionsBefore = MockRecognition.instances.length;
    expect(screen.getByRole('button', { name: /speaking/i })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(11_000); // past the minimum spoken-reply ceiling
    });
    flushTimers();

    expect(MockRecognition.instances.length).toBe(recognitionsBefore + 1);
    expect(screen.getByRole('button', { name: /listening/i })).toBeInTheDocument();
  });

  it('keeps a long reply alive against Chrome cutting it off, then stops poking', async () => {
    autoFinishSpeech = false;
    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    await act(async () => {
      MockRecognition.instances[0].say('summarise every open order');
      MockRecognition.instances[0].stop();
    });
    flushTimers();

    const resume = window.speechSynthesis.resume as any;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(resume).toHaveBeenCalled();

    // The reply has ended by now (the watchdog settled it). The keep-alive
    // must not outlive it, or it pokes synthesis for the rest of the session.
    const afterFinish = resume.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(resume.mock.calls.length).toBe(afterFinish);
  });

  it('releases the microphone and does not restart when the page unmounts mid-turn', () => {
    const { unmount } = renderPage();
    fireEvent.click(voiceButton());
    flushTimers();
    const rec = MockRecognition.instances[0];

    unmount();
    flushTimers();

    expect(rec.aborted).toBe(true);
    expect(rec.started).toBe(false);
    // Handlers detached: `onend` is what used to restart the turn, keeping an
    // orphan recognition on the mic after navigation.
    expect(rec.onend).toBeNull();
    expect(MockRecognition.instances).toHaveLength(1);
  });

  it('does not send a half-finished utterance after navigating away', () => {
    const { unmount } = renderPage();
    fireEvent.click(voiceButton());
    flushTimers();
    act(() => MockRecognition.instances[0].say('what is the status of'));

    unmount();
    flushTimers();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('works again on the next visit to the page', () => {
    const first = renderPage();
    fireEvent.click(voiceButton());
    flushTimers();
    first.unmount();
    flushTimers();

    renderPage();
    fireEvent.click(voiceButton());
    flushTimers();

    expect(MockRecognition.instances).toHaveLength(2);
    expect(MockRecognition.instances[1].started).toBe(true);
    expect(screen.getByRole('button', { name: /listening/i })).toBeInTheDocument();
  });
});
