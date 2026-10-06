/**
 * Shared "ask AI" chat page. Renders the conversation UI and drives the
 * assistant/tool-call turn-taking; each consuming app supplies its own
 * `sendMessage` (their HTTP client + auth convention differ — MIP uses an
 * axios instance, TBWC plain `fetch` + Supabase token) and its own copy
 * (title, suggested questions) since the backend tool set differs per app.
 * Pairs with the shared agentic loop in
 * @meterit/framework-backend/api/base/aiChat on the server side.
 *
 * Conversation state lives in useAiChatStore (a module-level zustand store,
 * see ./store), not component state — this page unmounts every time the user
 * navigates to another module, and plain useState would lose the whole
 * conversation on the way back. "New Chat" is the only thing that clears it.
 */
import React, { useRef, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Box,
  TextField,
  IconButton,
  Button,
  Typography,
  Paper,
  CircularProgress,
  Chip,
  Stack,
  Menu,
  MenuItem,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import AddIcon from '@mui/icons-material/Add';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import MicIcon from '@mui/icons-material/Mic';
import HeadsetMicIcon from '@mui/icons-material/HeadsetMic';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { useAiChatStore } from './store';
import { detectVoiceActivity, type StopVoiceActivity } from './voiceActivity';
import type { AiChatPageConfig, AiChatResultLink } from './types';

// Tools that run on nearly every turn (memory check) or are noise to a user
// (raw SQL) — not worth a chip under the reply.
const HIDDEN_TOOL_CHIPS = new Set(['run_sql_query', 'memory']);

/** Chrome/Edge only; feature-detected so other browsers just don't see the mic. */
const SpeechRecognitionCtor: any =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;

/** How long to wait after the user stops producing new speech results before
 *  treating a voice-mode turn as finished. Chrome's own `continuous=false`
 *  auto-stop fires on the first brief pause (often under a second) — far
 *  shorter than a natural mid-sentence pause — which cut users off mid-
 *  thought. Running `continuous=true` and finalizing on our own timer instead
 *  fixes that. */
const VOICE_SILENCE_MS = 1500;

/** Hard ceiling on one voice-mode turn, independent of VOICE_SILENCE_MS.
 *  `continuous=true` was reverted once already (see startVoiceTurn) because
 *  Chrome on Windows can fail to fire `onresult` at all, so the
 *  VOICE_SILENCE_MS timer — which only (re)starts from inside `onresult` —
 *  never starts and the turn hangs forever. This timer doesn't depend on
 *  `onresult` firing, so it force-ends the turn even when that happens,
 *  without reintroducing continuous mode's old infinite-hang failure mode. */
const VOICE_MAX_TURN_MS = 20_000;

/** Chrome does not release the audio device synchronously, so starting the
 *  next recognition from inside the previous one's `onend` (or right after
 *  aborting a stale one) throws `InvalidStateError` or errors straight back
 *  out with `aborted`. Restarting off a short timer instead of recursing
 *  gives the device a tick to come free. */
const VOICE_RESTART_DELAY_MS = 250;

/** Chrome stops speaking roughly 15s into a long utterance unless something
 *  pokes it; `resume()` on this interval is the standard defence. Replies here
 *  routinely run longer than that. */
const TTS_KEEPALIVE_MS = 10_000;

/** Ceiling on one spoken reply, from its length (speech runs ~15 chars/sec, so
 *  this is generous) and clamped below. Needed because voice mode AWAITS
 *  speak(): if `onend` never arrives - which happens when Chrome's synthesis
 *  gets wedged, or the tab is backgrounded mid-utterance - the promise never
 *  settles and the next turn never starts, leaving voice mode dead with no
 *  error. Same failure the recognition side guards with VOICE_MAX_TURN_MS. */
const TTS_MIN_TIMEOUT_MS = 10_000;
const TTS_MAX_TIMEOUT_MS = 180_000;
const TTS_MS_PER_CHAR = 100;

/** Recognition errors where retrying is pointless (no mic, permission
 *  refused). On these, leave voice mode and say so — the old code restarted
 *  on every `onend` regardless, which hammered a denied mic forever while the
 *  button still claimed voice chat was on. */
const FATAL_SPEECH_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

/** The live SpeechRecognition for this page, tracked at module level and not
 *  only in a ref: refs die with the component, so a recognition still holding
 *  the microphone when the user navigated away mid-voice-chat was unreachable
 *  from the next mount — every later `start()` failed and voice chat stayed
 *  broken until a full page reload. */
let activeRecognition: any = null;

/** Hard-stops a recognition so it CANNOT come back. Detaching the handlers
 *  first is the whole point: both `stop()` and `abort()` fire `onend`, and
 *  that handler is what starts the next voice turn, so stopping without
 *  detaching is exactly how an unmounted page kept re-opening the mic. */
function killRecognition(recognition: any): void {
  if (!recognition) return;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  try {
    recognition.abort();
  } catch {
    /* already stopped */
  }
  if (activeRecognition === recognition) activeRecognition = null;
}

/** One tool-result row → its clickable card. A single action clicks straight
 *  through; two or more (e.g. a document-backed order result) pop a small
 *  menu to pick which one, instead of guessing which the user wants. */
const ResultCard: React.FC<{ link: AiChatResultLink }> = ({ link }) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const single = link.actions.length === 1 ? link.actions[0] : null;

  return (
    <>
      <Paper
        variant="outlined"
        onClick={(e) => (single ? single.onClick() : setAnchorEl(e.currentTarget))}
        sx={{
          px: 1.5,
          py: 1,
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover', borderColor: 'primary.main' },
        }}
      >
        <Typography variant="body2" fontWeight={600}>
          {link.label}
        </Typography>
        {link.sublabel && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', whiteSpace: 'pre-line', mt: 0.25, lineHeight: 1.5 }}
          >
            {link.sublabel}
          </Typography>
        )}
      </Paper>
      {!single && (
        <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={() => setAnchorEl(null)}>
          {link.actions.map((action) => (
            <MenuItem
              key={action.label}
              onClick={() => {
                setAnchorEl(null);
                action.onClick();
              }}
            >
              {action.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
};

export const AiChatPage: React.FC<AiChatPageConfig> = ({
  sendMessage,
  title = 'AI Assistant',
  subtitle = 'Ask a question to get started.',
  placeholder = 'Ask a question...',
  emptyStateText = 'Ask anything.',
  suggestedQuestions = [],
  resultLink,
}) => {
  const { messages, loading, error, addMessage, setLoading, setError, reset } = useAiChatStore();
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef('');
  const voiceModeRef = useRef(false);
  const speakingRef = useRef(false);
  const voiceTranscriptRef = useRef('');
  const voiceSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHardStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopBargeInRef = useRef<StopVoiceActivity | null>(null);
  const mountedRef = useRef(true);
  const autoRanRef = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  /** Releases the barge-in microphone, if one is open. */
  const stopBargeIn = () => {
    stopBargeInRef.current?.();
    stopBargeInRef.current = null;
  };

  const clearVoiceTimers = () => {
    if (voiceSilenceTimerRef.current) {
      clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = null;
    }
    if (voiceHardStopTimerRef.current) {
      clearTimeout(voiceHardStopTimerRef.current);
      voiceHardStopTimerRef.current = null;
    }
    if (voiceRestartTimerRef.current) {
      clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    // A recognition left over from a previous mount of this page may still
    // hold the microphone; clear it before anything here tries to start one.
    killRecognition(activeRecognition);
    return () => {
      mountedRef.current = false;
      // Clear voice mode BEFORE stopping anything: stopping fires `onend`,
      // and that handler starts the next turn whenever voice mode is on —
      // which is how navigating away mid-voice-chat left a mic-holding
      // recognition running (and its reply speaking) on the next screen.
      voiceModeRef.current = false;
      clearVoiceTimers();
      stopBargeIn();
      killRecognition(recognitionRef.current);
      recognitionRef.current = null;
      window.speechSynthesis?.cancel();
    };
  }, []);

  // Header search bar hands off "press Enter" here with the typed query —
  // run it once, then clear the nav state so a refresh/back doesn't resend it.
  useEffect(() => {
    const autoQuery = (location.state as any)?.autoQuery;
    if (autoQuery && !autoRanRef.current) {
      autoRanRef.current = true;
      handleSend(autoQuery);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Leaves voice mode and puts the UI back in sync with reality. Deliberately
   *  does not touch recognition — it's called from inside recognition's own
   *  error handler — only the mode flag, timers, TTS and the message. */
  const exitVoiceMode = (message?: string) => {
    voiceModeRef.current = false;
    clearVoiceTimers();
    stopBargeIn();
    window.speechSynthesis?.cancel();
    if (!mountedRef.current) return;
    setVoiceMode(false);
    setListening(false);
    if (message) setError(message);
  };

  /** `start()` throws synchronously (`InvalidStateError`) whenever another
   *  recognition in the page is still live. That throw used to escape the
   *  click handler after `setVoiceMode(true)` had already run, leaving the
   *  button lit with a dead mic — so the next click only toggled voice mode
   *  back off and the one after it tried again. That is the "have to click it
   *  a few times" bug: fail out of voice mode instead of lying about it. */
  const tryStart = (recognition: any): boolean => {
    try {
      recognition.start();
      return true;
    } catch {
      killRecognition(recognition);
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      exitVoiceMode('Could not start the microphone. Try again.');
      return false;
    }
  };

  const toggleListening = () => {
    if (!SpeechRecognitionCtor) return;

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    killRecognition(recognitionRef.current);
    killRecognition(activeRecognition);

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    baseTextRef.current = input ? `${input} ` : '';

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(baseTextRef.current + transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => {
      if (activeRecognition === recognition) activeRecognition = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    activeRecognition = recognition;
    if (!tryStart(recognition)) return;
    setListening(true);
  };

  const setSpeakingState = (value: boolean) => {
    speakingRef.current = value;
    if (!mountedRef.current) return;
    setSpeaking(value);
  };

  /** Reads text aloud; resolves once done (or immediately if TTS isn't
   *  available). Resolves early when `cancel()` interrupts it — which is how
   *  both the button's tap-to-interrupt and barge-in below end a reply: the
   *  caller then just carries on into the next voice turn.
   *
   *  While it plays, a microphone energy meter watches for the user starting
   *  to talk (see ./voiceActivity) and cancels playback when they do, so a
   *  long reply doesn't have to be sat through. That detector is deliberately
   *  not SpeechRecognition — a live recognition during playback transcribes
   *  the assistant's own voice and re-sends it as the next question, which is
   *  why barge-in was previously unsupported. An energy meter produces no
   *  text, so a false positive only ends a reply early. */
  const speak = (text: string) =>
    new Promise<void>((resolve) => {
      if (!text || !('speechSynthesis' in window)) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      let settled = false;
      const keepAlive = setInterval(() => window.speechSynthesis.resume(), TTS_KEEPALIVE_MS);
      const watchdog = setTimeout(
        () => {
          window.speechSynthesis.cancel();
          finish();
        },
        Math.min(Math.max(text.length * TTS_MS_PER_CHAR, TTS_MIN_TIMEOUT_MS), TTS_MAX_TIMEOUT_MS)
      );
      function finish() {
        if (settled) return;
        settled = true;
        clearInterval(keepAlive);
        clearTimeout(watchdog);
        stopBargeIn();
        setSpeakingState(false);
        resolve();
      }
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.cancel();
      setSpeakingState(true);
      window.speechSynthesis.speak(utterance);

      // Only in hands-free voice mode: typing a question and hearing it read
      // back shouldn't open the microphone at all.
      if (!voiceModeRef.current) return;
      stopBargeIn();
      void detectVoiceActivity({
        onSpeechStart: () => {
          stopBargeInRef.current = null;
          // cancel() fires the utterance's onend, so `finish` above runs and
          // the turn moves on to listening by the normal path.
          window.speechSynthesis.cancel();
          finish();
        },
      }).then((stop) => {
        // Playback may already have finished while permission was pending.
        if (settled || !voiceModeRef.current) stop();
        else stopBargeInRef.current = stop;
      });
    });

  /** One hands-free turn: listen for a single utterance, auto-send once the
   *  user stops talking. Only ever started while the assistant is NOT
   *  speaking (right after each reply finishes, or on the very first turn) —
   *  the built-in SpeechRecognition API has no echo-cancellation coordination
   *  with speechSynthesis, so a mic that's live while the reply is playing
   *  just transcribes the assistant's own TTS output and re-sends it as a new
   *  question, producing an endless self-answering loop. Barge-in is supported
   *  but never by this route: speak() watches microphone ENERGY (no text, so
   *  nothing can be fed back) and cancels playback, and only then does the
   *  next turn open recognition here.
   *
   *  `continuous=true`, finalizing on our own VOICE_SILENCE_MS timer instead
   *  of Chrome's own end-of-speech cutoff — `continuous=false` stops at the
   *  first brief pause (under a second), shorter than a natural mid-sentence
   *  pause, and was cutting users off before they finished talking.
   *
   *  This was tried once before and reverted: VOICE_SILENCE_MS only
   *  (re)starts from inside `onresult`, and Chrome's continuous mode is
   *  unreliable about firing `onresult` at all (esp. on Windows) — when it
   *  doesn't, the timer never starts and recognition never stops on its own.
   *  VOICE_MAX_TURN_MS is the fix for that: a hard ceiling, started once and
   *  never reset, that force-stops the turn regardless of whether onresult
   *  ever fires — so a silent/stuck mic ends the turn within
   *  VOICE_MAX_TURN_MS (and voice mode just listens again) instead of
   *  hanging forever, while a talking user is no longer cut off at the first
   *  short pause. */
  const startVoiceTurn = () => {
    if (!SpeechRecognitionCtor || !voiceModeRef.current || !mountedRef.current) return;

    // Never leave an older instance holding the mic — a second `start()`
    // while one is live throws and kills the turn before it begins.
    killRecognition(recognitionRef.current);
    killRecognition(activeRecognition);

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    voiceTranscriptRef.current = '';
    // A fatal error fires `onerror` and then `onend`; this flag is what stops
    // `onend` from restarting the turn straight back into the same failure.
    let fatal = false;

    const clearTimers = clearVoiceTimers;
    const resetSilenceTimer = () => {
      if (voiceSilenceTimerRef.current) clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = setTimeout(() => recognitionRef.current?.stop(), VOICE_SILENCE_MS);
    };
    voiceHardStopTimerRef.current = setTimeout(() => recognitionRef.current?.stop(), VOICE_MAX_TURN_MS);

    recognition.onresult = (event: any) => {
      // Rebuild from every result each time (not just from event.resultIndex)
      // — continuous mode keeps finalized segments at earlier indices as new
      // ones are appended, so this is the full utterance so far, not a delta.
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      voiceTranscriptRef.current = transcript;
      setInput(transcript);
      resetSilenceTimer();
    };
    recognition.onerror = (event: any) => {
      clearTimers();
      if (mountedRef.current) setListening(false);
      if (FATAL_SPEECH_ERRORS.has(event?.error)) {
        fatal = true;
        exitVoiceMode(
          event.error === 'audio-capture'
            ? 'No microphone found.'
            : 'Microphone access is blocked. Allow it in the browser, then start voice chat again.'
        );
      }
    };
    recognition.onend = () => {
      clearTimers();
      if (activeRecognition === recognition) activeRecognition = null;
      if (mountedRef.current) setListening(false);
      const said = voiceTranscriptRef.current.trim();
      // Unmounted (navigated away), voice mode off, or a dead mic: stop here.
      // Restarting from this handler regardless is what kept the mic open
      // after the page was gone.
      if (fatal || !mountedRef.current || !voiceModeRef.current) return;
      if (said) {
        handleSend(said);
      } else {
        // Silence (no speech detected) — keep listening rather than dropping out of voice mode.
        scheduleVoiceTurn();
      }
    };

    recognitionRef.current = recognition;
    activeRecognition = recognition;
    if (!tryStart(recognition)) return;
    setListening(true);
  };

  /** Starts the next voice turn off a timer instead of recursing from inside
   *  `onend`: see VOICE_RESTART_DELAY_MS — Chrome still holds the audio
   *  device at that point and an immediate `start()` fails. */
  const scheduleVoiceTurn = () => {
    if (voiceRestartTimerRef.current) clearTimeout(voiceRestartTimerRef.current);
    voiceRestartTimerRef.current = setTimeout(() => {
      voiceRestartTimerRef.current = null;
      startVoiceTurn();
    }, VOICE_RESTART_DELAY_MS);
  };

  const toggleVoiceMode = () => {
    if (!SpeechRecognitionCtor) return;
    if (voiceMode) {
      if (speakingRef.current) {
        // Tap-to-interrupt: stop the assistant talking without leaving voice mode.
        window.speechSynthesis?.cancel();
        return;
      }
      exitVoiceMode();
      killRecognition(recognitionRef.current);
      recognitionRef.current = null;
    } else {
      voiceModeRef.current = true;
      setVoiceMode(true);
      setError(null);
      // Via the timer, not directly: any stale recognition is aborted first
      // and Chrome needs a moment to hand the microphone over.
      scheduleVoiceTurn();
    }
  };

  const handleSend = async (text: string) => {
    const userMessage = text.trim();
    // Read the store live rather than using this render's `messages`/`loading`:
    // a voice turn arrives through the recognition `onend` closure captured
    // when that turn STARTED, so the render-scope values are stale by then.
    // That meant every follow-up voice turn posted an empty history and the
    // assistant lost the thread — "I don't have context on who 'her' refers
    // to" right after answering a question about her.
    const { messages: conversation, loading: busy } = useAiChatStore.getState();
    if (!userMessage || busy) return;

    setInput('');
    setError(null);

    const history = conversation.map((m) => ({ role: m.role, content: m.content }));
    addMessage({ role: 'user', content: userMessage });
    setLoading(true);

    try {
      const data = await sendMessage(userMessage, history);

      if (data.success) {
        addMessage({
          role: 'assistant',
          content: data.response ?? '',
          toolsUsed: data.tools_used,
          toolResults: data.tool_results,
        });
        // Release the composer before speaking: `loading` disables the input
        // and Send button, and speaking a long reply held them disabled for
        // its whole duration, so the user couldn't type while it talked.
        setLoading(false);
        if (voiceModeRef.current) {
          // Speak first, THEN open the mic — SpeechRecognition has no echo
          // cancellation against speechSynthesis, so listening while the
          // reply plays just transcribes the assistant's own voice and
          // re-sends it, looping forever. Tap-to-interrupt (the button) is
          // the supported way to cut a reply short, not talking over it.
          await speak(data.response ?? '');
          scheduleVoiceTurn();
        }
      } else {
        setError(data.message ?? 'An error occurred.');
        if (voiceModeRef.current) scheduleVoiceTurn();
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reach the AI. Please try again.');
      if (voiceModeRef.current) scheduleVoiceTurn();
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 80px)',
        maxWidth: 900,
        mx: 'auto',
        px: 2,
        py: 2,
      }}
    >
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={600}>
            {title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          {SpeechRecognitionCtor && (
            <Button
              size="small"
              variant={voiceMode ? 'contained' : 'outlined'}
              color={voiceMode ? (speaking ? 'warning' : 'error') : 'primary'}
              onClick={toggleVoiceMode}
              title={voiceMode ? (speaking ? 'Tap to interrupt' : 'Tap to end voice chat') : 'Start voice chat'}
              startIcon={
                speaking ? (
                  <VolumeUpIcon
                    fontSize="small"
                    sx={{
                      animation: 'ai-chat-speaking-pulse 0.9s ease-in-out infinite',
                      '@keyframes ai-chat-speaking-pulse': {
                        '0%, 100%': { opacity: 1 },
                        '50%': { opacity: 0.4 },
                      },
                    }}
                  />
                ) : (
                  <HeadsetMicIcon
                    fontSize="small"
                    sx={
                      listening
                        ? {
                            animation: 'ai-chat-mic-pulse 1.2s ease-in-out infinite',
                            '@keyframes ai-chat-mic-pulse': {
                              '0%, 100%': { opacity: 1 },
                              '50%': { opacity: 0.4 },
                            },
                          }
                        : undefined
                    }
                  />
                )
              }
              sx={{ borderRadius: 999, px: 1.5, py: 0.25, fontSize: 12, minHeight: 0 }}
            >
              {voiceMode ? (speaking ? 'Speaking…' : listening ? 'Listening…' : 'Voice Chat On') : 'Voice Chat'}
            </Button>
          )}
          <Button
            size="small"
            variant="outlined"
            onClick={reset}
            disabled={messages.length === 0 && !loading}
            startIcon={<AddIcon fontSize="small" />}
            sx={{ borderRadius: 999, px: 1.5, py: 0.25, fontSize: 12, minHeight: 0 }}
          >
            New Chat
          </Button>
        </Stack>
      </Box>

      <Paper
        variant="outlined"
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          bgcolor: 'background.default',
        }}
      >
        {messages.length === 0 && (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              color: 'text.secondary',
            }}
          >
            <SmartToyIcon sx={{ fontSize: 56, opacity: 0.3 }} />
            <Typography variant="body1" textAlign="center">
              {emptyStateText}
            </Typography>
            {suggestedQuestions.length > 0 && (
              <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="center" sx={{ maxWidth: 600 }}>
                {suggestedQuestions.map((q) => (
                  <Chip key={q} label={q} onClick={() => handleSend(q)} variant="outlined" clickable size="small" />
                ))}
              </Stack>
            )}
          </Box>
        )}

        {messages.map((msg, idx) => (
          <Box
            key={idx}
            sx={{
              display: 'flex',
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              gap: 1.5,
              alignItems: 'flex-start',
            }}
          >
            <Box
              sx={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                bgcolor: msg.role === 'user' ? 'primary.main' : 'grey.200',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                mt: 0.5,
              }}
            >
              {msg.role === 'user' ? (
                <PersonIcon sx={{ fontSize: 18, color: 'white' }} />
              ) : (
                <SmartToyIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              )}
            </Box>

            <Box sx={{ maxWidth: '80%' }}>
              <Paper
                elevation={0}
                sx={{
                  px: 2,
                  py: 1.5,
                  bgcolor: msg.role === 'user' ? 'primary.main' : 'background.paper',
                  color: msg.role === 'user' ? 'primary.contrastText' : 'text.primary',
                  borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  border: msg.role === 'assistant' ? '1px solid' : 'none',
                  borderColor: 'divider',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <Typography variant="body2" sx={{ color: 'inherit' }}>
                  {msg.content}
                </Typography>
              </Paper>
              {msg.toolsUsed && msg.toolsUsed.filter((t) => !HIDDEN_TOOL_CHIPS.has(t)).length > 0 && (
                <Stack direction="row" gap={0.5} flexWrap="wrap" mt={0.5}>
                  {[...new Set(msg.toolsUsed.filter((t) => !HIDDEN_TOOL_CHIPS.has(t)))].map((tool) => (
                    <Chip key={tool} label={tool.replace(/_/g, ' ')} size="small" variant="outlined" sx={{ fontSize: 10, height: 20 }} />
                  ))}
                </Stack>
              )}
              {resultLink && msg.toolResults && msg.toolResults.length > 0 && (
                <Stack direction="column" gap={0.5} mt={1}>
                  {msg.toolResults.flatMap((group) =>
                    group.data.slice(0, 8).map((row, i) => {
                      const link = resultLink(group.tool, row);
                      if (!link) return null;
                      return <ResultCard key={`${group.tool}-${i}`} link={link} />;
                    })
                  )}
                </Stack>
              )}
            </Box>
          </Box>
        ))}

        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box
              sx={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                bgcolor: 'grey.200',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <SmartToyIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
            </Box>
            <Paper
              elevation={0}
              sx={{
                px: 2,
                py: 1.5,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '16px 16px 16px 4px',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <CircularProgress size={14} />
              <Typography variant="body2" color="text.secondary">
                Thinking...
              </Typography>
            </Paper>
          </Box>
        )}

        {error && (
          <Box sx={{ px: 1 }}>
            <Typography variant="body2" color="error">
              {error}
            </Typography>
          </Box>
        )}

        <div ref={messagesEndRef} />
      </Paper>

      <Box sx={{ display: 'flex', gap: 1, mt: 1.5, alignItems: 'flex-end' }}>
        <TextField
          fullWidth
          multiline
          maxRows={4}
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          size="small"
          sx={{ bgcolor: 'background.paper' }}
          InputProps={{
            endAdornment: SpeechRecognitionCtor && !voiceMode ? (
                <IconButton
                  size="small"
                  onClick={toggleListening}
                  disabled={loading}
                  color={listening ? 'error' : 'default'}
                  title={listening ? 'Stop voice input' : 'Speak your question'}
                >
                  <MicIcon
                    fontSize="small"
                    sx={
                      listening
                        ? {
                            animation: 'ai-chat-mic-pulse 1.2s ease-in-out infinite',
                            '@keyframes ai-chat-mic-pulse': {
                              '0%, 100%': { opacity: 1 },
                              '50%': { opacity: 0.4 },
                            },
                          }
                        : { opacity: 0.6 }
                    }
                  />
                </IconButton>
            ) : undefined,
          }}
        />
        <IconButton
          color="primary"
          onClick={() => handleSend(input)}
          disabled={loading || !input.trim()}
          sx={{
            bgcolor: 'primary.main',
            color: 'white',
            '&:hover': { bgcolor: 'primary.dark' },
            '&.Mui-disabled': { bgcolor: 'action.disabledBackground' },
            mb: 0.25,
          }}
        >
          {loading ? <CircularProgress size={20} color="inherit" /> : <SendIcon />}
        </IconButton>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, textAlign: 'center' }}>
        Press Enter to send, Shift+Enter for a new line
      </Typography>
    </Box>
  );
};

export default AiChatPage;
