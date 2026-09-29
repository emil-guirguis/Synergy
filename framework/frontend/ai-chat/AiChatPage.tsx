/**
 * Shared "ask SI" chat page. Renders the conversation UI and drives the
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
import type { AiChatPageConfig, AiChatResultLink } from './types';

/** Chrome/Edge only; feature-detected so other browsers just don't see the mic. */
const SpeechRecognitionCtor: any =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;

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
  title = 'SI Assistant',
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
  const autoRanRef = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
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

  const toggleListening = () => {
    if (!SpeechRecognitionCtor) return;

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

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
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const setSpeakingState = (value: boolean) => {
    speakingRef.current = value;
    setSpeaking(value);
  };

  /** Reads text aloud; resolves once done (or immediately if TTS isn't available).
   *  Resolves early if `cancel()` interrupts it — e.g. the barge-in check below. */
  const speak = (text: string) =>
    new Promise<void>((resolve) => {
      if (!text || !('speechSynthesis' in window)) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      const finish = () => {
        setSpeakingState(false);
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.cancel();
      setSpeakingState(true);
      window.speechSynthesis.speak(utterance);
    });

  /** One hands-free turn: listen for a single utterance, auto-send it once the
   *  user stops talking. Started right after each assistant reply — while
   *  voice mode is on — so the mic is already live both for barge-in (talking
   *  over the reply) and for capturing whatever comes next once it finishes. */
  const startVoiceTurn = () => {
    if (!SpeechRecognitionCtor || !voiceModeRef.current) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    voiceTranscriptRef.current = '';

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      voiceTranscriptRef.current = transcript;
      setInput(transcript);
      // Barge-in: the user started talking while the assistant was still
      // reading its reply out loud — cut it off so it doesn't talk over them.
      // (Relies on the browser's own echo cancellation to avoid the mic
      // re-triggering off the TTS audio itself; behavior varies by device.)
      if (transcript.trim() && speakingRef.current) {
        window.speechSynthesis?.cancel();
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => {
      setListening(false);
      const said = voiceTranscriptRef.current.trim();
      if (said) {
        handleSend(said);
      } else if (voiceModeRef.current) {
        // Silence (no speech detected) — keep listening rather than dropping out of voice mode.
        startVoiceTurn();
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const toggleVoiceMode = () => {
    if (!SpeechRecognitionCtor) return;
    if (voiceMode) {
      if (speakingRef.current) {
        // Tap-to-interrupt: stop the assistant talking without leaving voice mode.
        window.speechSynthesis?.cancel();
        return;
      }
      voiceModeRef.current = false;
      setVoiceMode(false);
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    } else {
      voiceModeRef.current = true;
      setVoiceMode(true);
      startVoiceTurn();
    }
  };

  const handleSend = async (text: string) => {
    const userMessage = text.trim();
    if (!userMessage || loading) return;

    setInput('');
    setError(null);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
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
        if (voiceModeRef.current) {
          // Start listening before speaking, not after — this is what makes
          // barge-in possible, and it doubles as listening for the next reply
          // once the assistant finishes talking.
          startVoiceTurn();
          await speak(data.response ?? '');
        }
      } else {
        setError(data.message ?? 'An error occurred.');
        if (voiceModeRef.current) startVoiceTurn();
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reach the AI. Please try again.');
      if (voiceModeRef.current) startVoiceTurn();
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
              {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                <Stack direction="row" gap={0.5} flexWrap="wrap" mt={0.5}>
                  {[...new Set(msg.toolsUsed)].map((tool) => (
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
