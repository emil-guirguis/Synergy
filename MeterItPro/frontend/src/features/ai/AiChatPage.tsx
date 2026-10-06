import React from 'react';
import { AiChatPage as SharedAiChatPage, type AiChatResponse } from '@meterit/framework-frontend/ai-chat';
import apiClient from '../../services/apiClient';

const SUGGESTED_QUESTIONS = [
  'Which meters have not reported in the last 48 hours?',
  'What is my total energy consumption today?',
  'Are there any active alert rules that have triggered recently?',
  'Give me a summary of all my meters and their latest readings.',
];

// Up to 8 tool-call round trips on the backend (runAiChatLoop), so a slow but
// legitimate reply takes a while. Without this the shared apiClient has no
// timeout at all: a hung call (an Anthropic API stall) left the request
// pending forever, `loading` never cleared, and Send and the mic stayed
// disabled until a page reload. TBWC's client already guards this.
const CHAT_TIMEOUT_MS = 60_000;

async function sendMessage(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<AiChatResponse> {
  try {
    const res = await apiClient.post('/ai/chat', { message, history }, { timeout: CHAT_TIMEOUT_MS });
    return res.data;
  } catch (err: any) {
    throw new Error(err?.response?.data?.message ?? err?.message ?? 'Failed to reach the AI. Please try again.');
  }
}

export const AiChatPage: React.FC = () => (
  <SharedAiChatPage
    sendMessage={sendMessage}
    title="AI Assistant (Zenith)"
    subtitle="Ask questions about your meters, readings, and alerts."
    placeholder="Ask about your meters, readings, alerts..."
    emptyStateText="Ask anything about your facility's energy data."
    suggestedQuestions={SUGGESTED_QUESTIONS}
  />
);

export default AiChatPage;
