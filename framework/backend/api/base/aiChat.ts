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
  /** Provider-specific content the loop must hand back untouched on the next
   *  call but has no business interpreting - Anthropic's thinking blocks,
   *  which have to accompany the assistant turn they came from when tool
   *  results follow it. Opaque here on purpose: this module stays
   *  provider-agnostic, and the adapter that produced them consumes them. */
  providerBlocks?: unknown[];
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
  /** True when the model declined the question as outside its allowed scope
   *  (see AI_CHAT_OUT_OF_SCOPE_MARKER) — callers should surface this as an
   *  error response rather than a normal chat reply. */
  outOfScope: boolean;
}

/** Sentinel the model is instructed to answer with verbatim, and nothing else,
 *  when a question can't be answered by the tools it's given — e.g. general
 *  knowledge (weather, news, math) unrelated to the app's own data. Detected
 *  in the loop below and reported via `outOfScope` instead of being shown to
 *  the user as a normal assistant reply. */
export const AI_CHAT_OUT_OF_SCOPE_MARKER = '__OUT_OF_SCOPE__';

/** Append to an app's systemPrompt to lock the assistant to tool-answerable
 *  (database search/analysis) questions only, for now. */
export const AI_CHAT_SCOPE_GUARDRAIL =
  'You may ONLY answer questions that can be answered using the tools provided — this app\'s own ' +
  "database. Do not use general knowledge and do not answer questions unrelated to this app's data " +
  '(weather, news, math, coding help, other companies/products, personal advice, etc.), even if you ' +
  'know the answer. If the question cannot be answered with the tools available to you, respond with ' +
  `EXACTLY this text and nothing else, no punctuation or commentary: ${AI_CHAT_OUT_OF_SCOPE_MARKER}`;

/**
 * Cleans a client-supplied history into something a provider will accept,
 * with the new message appended as the final user turn.
 *
 * Both rules exist because the client stores the conversation optimistically
 * and the Anthropic Messages API is strict about the result:
 *  - A turn that FAILED (network error, 502 from the model host) leaves the
 *    user's question in the store with no assistant reply next to it. The
 *    next send then posts two user turns in a row, which is rejected for
 *    non-alternating roles - so one failed turn broke every later message in
 *    that conversation until "New Chat". Consecutive same-role turns are
 *    merged rather than dropped, so the unanswered question still reaches
 *    the model.
 *  - An assistant turn that produced no text at all is stored as "", and an
 *    empty content block is likewise rejected. Those are dropped.
 */
/** How many past turns to resend. The whole conversation goes up with every
 *  message, so an afternoon in one chat grows the bill and eventually the
 *  context window without the user doing anything unusual. Ten exchanges is
 *  well past what a follow-up question needs; "New Chat" is still the way to
 *  start clean. Oldest turns are dropped, never the newest. */
export const MAX_HISTORY_ENTRIES = 20;

/** Cap on ONE tool result as fed back to the model. run_sql_query alone can
 *  return 500 rows, and up to maxIterations of those accumulate in a single
 *  request - the largest token cost in the loop by far, and a context-limit
 *  failure waiting to happen. The caller still receives the untruncated
 *  result for rendering (see AiChatLoopResult.toolResults), so the clickable
 *  cards keep every row. */
export const MAX_TOOL_RESULT_CHARS = 20_000;

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  // Say so explicitly: silently cutting JSON mid-object invites the model to
  // treat a severed row as the real data, or to report a total it can't see.
  return (
    `${result.slice(0, MAX_TOOL_RESULT_CHARS)}

[truncated: this result was ${result.length} characters, ` +
    `showing the first ${MAX_TOOL_RESULT_CHARS}. Narrow the query (fewer columns, a tighter filter, or a ` +
    `smaller LIMIT) if you need the rest - do not report totals or counts from this partial output.]`
  );
}

export function normaliseChatHistory(
  history: AiChatHistoryEntry[],
  message: string
): AiChatHistoryEntry[] {
  const allowedRoles = new Set(['user', 'assistant']);
  const entries = [...history, { role: 'user' as const, content: message }]
    .filter((h) => h && allowedRoles.has(h.role) && typeof h.content === 'string')
    .map((h) => ({ role: h.role, content: h.content.trim() }))
    .filter((h) => h.content.length > 0);

  // A conversation has to open with the user; a leading assistant turn (only
  // reachable from a malformed history) would be rejected outright.
  while (entries.length > 0 && entries[0].role === 'assistant') entries.shift();

  const merged: AiChatHistoryEntry[] = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === entry.role) {
      previous.content = `${previous.content}

${entry.content}`;
    } else {
      merged.push({ ...entry });
    }
  }

  // Trim oldest-first, then re-drop any assistant turn left at the front so
  // the trimmed conversation still opens with a user turn.
  const trimmed = merged.slice(-MAX_HISTORY_ENTRIES);
  while (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  return trimmed;
}

export async function runAiChatLoop(
  message: string,
  history: AiChatHistoryEntry[],
  config: RunAiChatLoopConfig
): Promise<AiChatLoopResult> {
  const messages: AiChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    ...normaliseChatHistory(history, message),
  ];

  const toolsUsed: string[] = [];
  const toolResults: AiChatToolResult[] = [];
  const maxIterations = config.maxIterations ?? 8;

  const validToolNames = config.tools.map((t) => t.function.name);

  for (let i = 0; i < maxIterations; i++) {
    const assistantMsg = await config.complete(messages);

    // Groq's gpt-oss models occasionally leak an internal "harmony" format
    // control token onto the end of an otherwise-correct tool name, e.g.
    // "search_orders<|channel|>commentary" instead of "search_orders". Left
    // alone, that garbled name re-enters the conversation history below and
    // the provider's own request validation 400s the *next* completion call
    // because it no longer matches any tool in `tools` — repair it here,
    // before it's used or persisted.
    for (const toolCall of assistantMsg.tool_calls ?? []) {
      if (!validToolNames.includes(toolCall.function.name)) {
        const repaired = validToolNames.find((name) => toolCall.function.name.startsWith(name));
        if (repaired) toolCall.function.name = repaired;
      }
    }

    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const content = assistantMsg.content ?? '';
      return {
        response: content,
        toolsUsed,
        toolResults,
        outOfScope: content.trim() === AI_CHAT_OUT_OF_SCOPE_MARKER,
      };
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
        return { role: 'tool' as const, tool_call_id: toolCall.id, content: truncateToolResult(result) };
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
    outOfScope: false,
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
