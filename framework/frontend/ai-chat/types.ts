export interface AiChatToolResultGroup {
  tool: string;
  data: Record<string, any>[];
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  toolResults?: AiChatToolResultGroup[];
}

export interface AiChatResponse {
  success: boolean;
  response?: string;
  message?: string;
  tools_used?: string[];
  tool_results?: AiChatToolResultGroup[];
}

export interface AiChatResultLink {
  label: string;
  sublabel?: string;
  onClick: () => void;
}

export interface AiChatPageConfig {
  /** Posts one message + prior turns to the app's /api/ai/chat route. */
  sendMessage: (
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ) => Promise<AiChatResponse>;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  emptyStateText?: string;
  suggestedQuestions?: string[];
  /**
   * Turns one row from a search tool's result into a clickable link (e.g. open
   * the record's form). Called per-row for every tool_results group; return
   * null for rows/tools that shouldn't be linkable. Omit entirely to render
   * tool results as plain (non-clickable) chips, same as before this existed.
   */
  resultLink?: (tool: string, row: Record<string, any>) => AiChatResultLink | null;
}
