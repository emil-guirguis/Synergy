import { describe, it, expect } from 'vitest';
import { toClaudeMessages, fromClaudeMessage, toClaudeTools } from './claudeChatAdapter';
import type { AiChatMessage } from '@meterit/framework-backend/api/base/aiChat';

/** One assistant turn that asked for two tools at once, then both results —
 *  exactly what runAiChatLoop builds when Claude calls tools in parallel. */
const parallelToolTurn: AiChatMessage[] = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: 'who is Jenifer and what is she owed?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'search_users', arguments: '{"text":"Jenifer"}' } },
      { id: 'call_b', type: 'function', function: { name: 'search_invoices', arguments: '{"text":"Jenifer"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_a', content: '[{"id":"u1"}]' },
  { role: 'tool', tool_call_id: 'call_b', content: '[{"invoice":"1234"}]' },
];

describe('toClaudeMessages', () => {
  it('lifts the system message out of the list', () => {
    const { system, messages } = toClaudeMessages(parallelToolTurn);
    expect(system).toBe('be helpful');
    expect(messages.every((m) => m.role !== ('system' as any))).toBe(true);
  });

  it('never emits two messages of the same role in a row', () => {
    const { messages } = toClaudeMessages(parallelToolTurn);
    const roles = messages.map((m) => m.role);
    const consecutive = roles.filter((role, i) => i > 0 && role === roles[i - 1]);
    // The Anthropic Messages API rejects consecutive same-role messages, so
    // parallel tool results have to share ONE user message.
    expect(consecutive).toEqual([]);
  });

  it('puts both parallel tool results in a single user message', () => {
    const { messages } = toClaudeMessages(parallelToolTurn);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_a', content: '[{"id":"u1"}]' },
      { type: 'tool_result', tool_use_id: 'call_b', content: '[{"invoice":"1234"}]' },
    ]);
  });

  it('keeps the assistant tool_use turn intact', () => {
    const { messages } = toClaudeMessages(parallelToolTurn);
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'search_users', input: { text: 'Jenifer' } },
      { type: 'tool_use', id: 'call_b', name: 'search_invoices', input: { text: 'Jenifer' } },
    ]);
  });

  it('keeps a plain back-and-forth conversation as-is', () => {
    const { messages } = toClaudeMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);
  });

  it('keeps assistant text alongside its tool calls', () => {
    const { messages } = toClaudeMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_users', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[]' },
    ]);
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'c1', name: 'search_users', input: {} },
    ]);
  });

  it('survives tool-call arguments that are not valid JSON', () => {
    const { messages } = toClaudeMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_users', arguments: '{bad' } }],
      },
    ]);
    expect((messages[1].content as any)[0].input).toEqual({});
  });
});

describe('fromClaudeMessage', () => {
  it('splits text and tool calls out of a response', () => {
    const msg = fromClaudeMessage({
      content: [
        { type: 'text', text: 'Looking that up.' },
        { type: 'tool_use', id: 'c1', name: 'search_users', input: { text: 'Emil' } },
      ],
    } as any);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Looking that up.');
    expect(msg.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'search_users', arguments: '{"text":"Emil"}' } },
    ]);
  });

  it('reports no tool calls for a plain answer', () => {
    const msg = fromClaudeMessage({ content: [{ type: 'text', text: 'Three orders.' }] } as any);
    expect(msg.tool_calls).toBeUndefined();
    expect(msg.content).toBe('Three orders.');
  });
});

describe('extended thinking round trip', () => {
  it('keeps thinking blocks off the loop-visible content but carries them', () => {
    const msg = fromClaudeMessage({
      content: [
        { type: 'thinking', thinking: 'she means Jenifer', signature: 'sig' },
        { type: 'text', text: 'Looking that up.' },
        { type: 'tool_use', id: 'c1', name: 'search_users', input: {} },
      ],
    } as any);
    expect(msg.content).toBe('Looking that up.');
    expect(msg.providerBlocks).toEqual([{ type: 'thinking', thinking: 'she means Jenifer', signature: 'sig' }]);
  });

  it('replays thinking blocks FIRST in the assistant turn', () => {
    // With thinking enabled, the blocks of an assistant turn must accompany it
    // when its tool results follow, and must precede text and tool_use.
    const { messages } = toClaudeMessages([
      { role: 'user', content: 'who is she' },
      {
        role: 'assistant',
        content: 'Looking.',
        providerBlocks: [{ type: 'thinking', thinking: 'she means Jenifer', signature: 'sig' }],
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_users', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[]' },
    ]);
    expect((messages[1].content as any[]).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('is unaffected when the model returns no thinking blocks', () => {
    const msg = fromClaudeMessage({ content: [{ type: 'text', text: 'Three orders.' }] } as any);
    expect(msg.providerBlocks).toBeUndefined();
    const { messages } = toClaudeMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_users', arguments: '{}' } }],
      },
    ]);
    expect((messages[1].content as any[]).map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('carries redacted thinking too', () => {
    const msg = fromClaudeMessage({
      content: [{ type: 'redacted_thinking', data: 'abc' }, { type: 'text', text: 'ok' }],
    } as any);
    expect(msg.providerBlocks).toEqual([{ type: 'redacted_thinking', data: 'abc' }]);
  });
});

describe('toClaudeTools', () => {
  it('maps the OpenAI-shaped tool definition onto Claude input_schema', () => {
    expect(
      toClaudeTools([
        {
          type: 'function',
          function: { name: 'search_users', description: 'find users', parameters: { type: 'object' } },
        },
      ])
    ).toEqual([{ name: 'search_users', description: 'find users', input_schema: { type: 'object' } }]);
  });
});
