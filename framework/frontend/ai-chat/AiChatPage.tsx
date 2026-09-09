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
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import AddIcon from '@mui/icons-material/Add';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import { useAiChatStore } from './store';
import type { AiChatPageConfig } from './types';

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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

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
      } else {
        setError(data.message ?? 'An error occurred.');
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reach the AI. Please try again.');
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
                  bgcolor: msg.role === 'user' ? 'primary.light' : 'background.paper',
                  color: msg.role === 'user' ? '#fff' : 'text.primary',
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
                      return (
                        <Paper
                          key={`${group.tool}-${i}`}
                          variant="outlined"
                          onClick={link.onClick}
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
                      );
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
