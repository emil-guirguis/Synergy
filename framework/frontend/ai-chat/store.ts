/**
 * Module-level (not component-level) chat state — a zustand store, so it
 * survives AiChatPage unmounting when the user navigates to another module
 * and back, instead of resetting like plain useState would. One conversation
 * per browser tab per app; "New Chat" clears it explicitly via reset().
 */
import { create } from 'zustand';
import type { AiChatMessage } from './types';

interface AiChatState {
  messages: AiChatMessage[];
  loading: boolean;
  error: string | null;
  addMessage: (message: AiChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useAiChatStore = create<AiChatState>((set) => ({
  messages: [],
  loading: false,
  error: null,
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () => set({ messages: [], loading: false, error: null }),
}));
