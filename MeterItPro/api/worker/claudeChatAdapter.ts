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
/** True for a user message whose content is only tool_result blocks - i.e.
 *  one more result from the same assistant turn can be appended to it. */
function isToolResultContent(
  content: Anthropic.MessageParam['content']
): content is Anthropic.ContentBlockParam[] {
  return Array.isArray(content) && content.length > 0 && content.every((b) => b.type === 'tool_result');
}

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
      const block: Anthropic.ContentBlockParam = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id!,
        content: m.content ?? '',
      };
      // Claude routinely calls several tools in ONE assistant turn, and the
      // loop hands back one tool message per call. All of their results have
      // to arrive as blocks of a SINGLE user message: pushing one message
      // each produced consecutive user turns, which the Messages API rejects
      // for non-alternating roles - so every parallel-tool turn failed the
      // whole request.
      const previous = claudeMessages[claudeMessages.length - 1];
      if (previous?.role === 'user' && isToolResultContent(previous.content)) {
        previous.content.push(block);
      } else {
        claudeMessages.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      // Thinking blocks must come FIRST in the turn they belong to, ahead of
      // any text or tool_use - hence replayed here, not appended.
      const content: Anthropic.ContentBlockParam[] = [...((m.providerBlocks ?? []) as Anthropic.ContentBlockParam[])];
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

/** Converts one Claude response back into the loop's AiChatMessage shape.
 *  Thinking blocks are carried through as opaque providerBlocks rather than
 *  dropped: with extended thinking on (the route requests it), the blocks of
 *  an assistant turn must be sent back with it when its tool results follow,
 *  or the next call is rejected. */
export function fromClaudeMessage(response: Anthropic.Message): AiChatMessage {
  const textParts: string[] = [];
  const toolCalls: NonNullable<AiChatMessage['tool_calls']> = [];
  const thinking: Anthropic.ContentBlockParam[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      thinking.push(block as Anthropic.ContentBlockParam);
    }
  }

  return {
    role: 'assistant',
    content: textParts.join('\n') || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(thinking.length ? { providerBlocks: thinking } : {}),
  };
}
