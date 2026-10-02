/**
 * Converts between the shared agentic loop's OpenAI-shaped duck types
 * (AiChatMessage/AiChatTool — see @meterit/framework-backend/api/base/aiChat)
 * and the Anthropic Messages API shapes, so runAiChatLoop can drive a Claude
 * client without the loop itself knowing which provider is behind it.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AiChatMessage, AiChatTool } from '@meterit/framework-backend/api/base/aiChat';

export function toClaudeTools(tools: AiChatTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

/** Splits the loop's flat message list into Claude's {system, messages}
 *  shape. The leading `system`-role entry becomes the top-level `system`
 *  string; tool calls/results become tool_use/tool_result content blocks. */
export function toClaudeMessages(messages: AiChatMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  let system = '';
  const claudeMessages: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system = m.content ?? '';
      continue;
    }

    if (m.role === 'tool') {
      claudeMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id!, content: m.content ?? '' }],
      });
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const toolCall of m.tool_calls) {
        let input: Record<string, any> = {};
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          // leave as empty object
        }
        content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input });
      }
      claudeMessages.push({ role: 'assistant', content });
      continue;
    }

    claudeMessages.push({ role: m.role as 'user' | 'assistant', content: m.content ?? '' });
  }

  return { system, messages: claudeMessages };
}

/** Converts one Claude response back into the loop's AiChatMessage shape. */
export function fromClaudeMessage(response: Anthropic.Message): AiChatMessage {
  const textParts: string[] = [];
  const toolCalls: NonNullable<AiChatMessage['tool_calls']> = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }

  return {
    role: 'assistant',
    content: textParts.join('\n') || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}
