/**
 * Shared tool-use agentic loop for "ask AI" chat routes. Each consuming app's
 * worker/routes/aiChat.ts keeps its own OpenAI-compatible client, tool
 * definitions, and executeTool() (queries differ per app/tenant model) and
 * hands this module a `complete` callback plus the tool set — this only owns
 * the loop: call the model, run any tool calls it asks for, feed results back,
 * repeat until it answers with no more tool calls or maxIterations is hit.
 *
 * Deliberately not importing the `openai` package here (see auth.ts's comment
 * on the duplicate-package hazard): each app already depends on its own copy
 * to build the client, so this only needs minimal duck-typed message/tool
 * shapes wide enough for that client's real types to satisfy structurally.
 */

export interface AiChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AiChatToolCall[];
  tool_call_id?: string;
}

export interface AiChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface AiChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunAiChatLoopConfig {
  systemPrompt: string;
  tools: AiChatTool[];
  /** Calls the model with the running message list; returns its reply message. */
  complete: (messages: AiChatMessage[]) => Promise<AiChatMessage>;
  /** Executes one tool call and returns its result as a string (JSON, usually). */
  executeTool: (toolName: string, input: Record<string, any>) => Promise<string>;
  /** Safety cap on tool-call round trips. Default 8. */
  maxIterations?: number;
}

/** One tool call's raw result, kept alongside the text answer so a caller can
 *  render the underlying records (e.g. a clickable link to the record a
 *  search tool found) instead of only the model's prose summary of them. */
export interface AiChatToolResult {
  tool: string;
  /** Raw string returned by executeTool() — JSON in every current tool, but
   *  kept as a string here since this module doesn't assume that shape. */
  result: string;
}

export interface AiChatLoopResult {
  response: string;
  toolsUsed: string[];
  toolResults: AiChatToolResult[];
}

export async function runAiChatLoop(
  message: string,
  history: AiChatHistoryEntry[],
  config: RunAiChatLoopConfig
): Promise<AiChatLoopResult> {
  const allowedRoles = new Set(['user', 'assistant']);
  const messages: AiChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    ...history
      .filter((h) => allowedRoles.has(h.role) && typeof h.content === 'string')
      .map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message.trim() },
  ];

  const toolsUsed: string[] = [];
  const toolResults: AiChatToolResult[] = [];
  const maxIterations = config.maxIterations ?? 8;

  for (let i = 0; i < maxIterations; i++) {
    const assistantMsg = await config.complete(messages);
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return { response: assistantMsg.content ?? '', toolsUsed, toolResults };
    }

    const toolMessages = await Promise.all(
      assistantMsg.tool_calls.map(async (toolCall) => {
        toolsUsed.push(toolCall.function.name);
        let toolInput: Record<string, any> = {};
        try {
          toolInput = JSON.parse(toolCall.function.arguments);
        } catch {
          // leave as empty object
        }
        const result = await config.executeTool(toolCall.function.name, toolInput);
        toolResults.push({ tool: toolCall.function.name, result });
        return { role: 'tool' as const, tool_call_id: toolCall.id, content: result };
      })
    );

    messages.push(...toolMessages);
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  return {
    response:
      (typeof lastAssistant?.content === 'string' ? lastAssistant.content : '') ||
      'I was unable to complete the analysis. Please try again.',
    toolsUsed,
    toolResults,
  };
}

/**
 * Turns whatever `config.complete()` (or a tool) threw into a status + message
 * safe to send to the client — a bad/missing API key, rate limiting, and the
 * model host being down all look like plain thrown errors from here, and
 * without this every one of them surfaces as a bare "Internal server error"
 * from the Worker's top-level onError instead of something a caller can act on.
 */
export function describeAiChatError(err: unknown): { status: 502; message: string } {
  const anyErr = err as { status?: number; message?: string } | undefined;
  if (anyErr?.status === 401 || anyErr?.status === 403) {
    return { status: 502, message: 'AI chat is not configured correctly (invalid API key)' };
  }
  if (anyErr?.status === 429) {
    return { status: 502, message: 'AI chat is rate-limited right now — try again shortly' };
  }
  if (typeof anyErr?.message === 'string' && anyErr.message) {
    return { status: 502, message: `AI chat failed: ${anyErr.message}` };
  }
  return { status: 502, message: 'AI chat failed unexpectedly' };
}
