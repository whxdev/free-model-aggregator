// EXSALA HERMES MOD · powered by Gienetic
import type { Json, Wire } from './providers.ts';

export type CanonImage = { mediaType: string; data: string } | { url: string };
export interface CanonToolCall { id: string; name: string; arguments: string; }
export interface CanonToolResult { toolCallId: string; name: string | null; text: string; isError: boolean; }
export interface CanonMessage { role: 'system' | 'user' | 'assistant' | 'tool'; text: string; images: CanonImage[]; toolCalls: CanonToolCall[]; toolResults: CanonToolResult[]; }
export interface CanonTool { name: string; description: string | null; schema: Json | null; }
export interface CanonRequest { system: string | null; messages: CanonMessage[]; tools: CanonTool[]; maxTokens: number | null; stops: string[]; jsonMode: boolean; stream: boolean; temperature: number | null; }
export interface CanonAnswer { text: string; inputTokens: number; outputTokens: number; stopNative: string | null; }

const record = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const asString = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : String(value);
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const numberOrNull = (value: unknown): number | null => typeof value === 'number' ? value : null;
const emptyMessage = (role: CanonMessage['role']): CanonMessage => ({ role, text: '', images: [], toolCalls: [], toolResults: [] });

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => record(part).type === 'text').map(part => asString(record(part).text)).join('\n');
}

function openAIImage(value: unknown): CanonImage | null {
  const url = record(record(value).image_url).url;
  if (typeof url !== 'string') return null;
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : { url };
}

function openAIContent(value: unknown): { text: string; images: CanonImage[] } {
  if (typeof value === 'string') return { text: value, images: [] };
  if (!Array.isArray(value)) return { text: '', images: [] };
  const text = value.filter(part => record(part).type === 'text').map(part => asString(record(part).text)).join('\n');
  const images = value.filter(part => record(part).type === 'image_url').map(openAIImage).filter((image): image is CanonImage => image !== null);
  return { text, images };
}

export function parseOpenAIRequest(body: unknown): CanonRequest {
  const input = record(body);
  const systems: string[] = [];
  const messages: CanonMessage[] = [];
  for (const raw of Array.isArray(input.messages) ? input.messages : []) {
    const msg = record(raw);
    const role = msg.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(msg.content);
      if (text) systems.push(text);
      continue;
    }
    if (role === 'user') {
      const content = openAIContent(msg.content);
      messages.push({ ...emptyMessage('user'), ...content });
    } else if (role === 'assistant') {
      const content = openAIContent(msg.content);
      const message = { ...emptyMessage('assistant'), ...content };
      message.toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((call: unknown) => {
        const item = record(call);
        const fn = record(item.function);
        const args = fn.arguments;
        return { id: asString(item.id), name: asString(fn.name), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
      });
      messages.push(message);
    } else if (role === 'tool') {
      messages.push({ ...emptyMessage('tool'), toolResults: [{ toolCallId: asString(msg.tool_call_id), name: nullableString(msg.name), text: textOf(msg.content), isError: false }] });
    }
  }
  const tools: CanonTool[] = (Array.isArray(input.tools) ? input.tools : []).map((raw: unknown) => {
    const item = record(raw);
    const fn = record(item.type === 'function' ? item.function : item);
    return { name: asString(fn.name), description: nullableString(fn.description), schema: fn.parameters == null ? null : fn.parameters as Json };
  });
  const rawStop = input.stop;
  const stops = typeof rawStop === 'string' ? [rawStop] : Array.isArray(rawStop) ? rawStop.filter((item: unknown): item is string => typeof item === 'string') : [];
  const format = record(input.response_format);
  return {
    system: systems.length ? systems.join('\n') : null,
    messages,
    tools,
    maxTokens: typeof input.max_tokens === 'number' ? input.max_tokens : numberOrNull(input.max_completion_tokens),
    stops,
    jsonMode: format.type === 'json_object' || format.type === 'json_schema',
    stream: input.stream === true,
    temperature: numberOrNull(input.temperature),
  };
}

function anthropicContent(value: unknown): { text: string; images: CanonImage[]; toolCalls: CanonToolCall[]; toolResults: CanonToolResult[] } {
  if (typeof value === 'string') return { text: value, images: [], toolCalls: [], toolResults: [] };
  const texts: string[] = [];
  const images: CanonImage[] = [];
  const toolCalls: CanonToolCall[] = [];
  const toolResults: CanonToolResult[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const block = record(raw);
    if (block.type === 'text') texts.push(asString(block.text));
    else if (block.type === 'image') {
      const source = record(block.source);
      if (source.type === 'base64' && typeof source.media_type === 'string') images.push({ mediaType: source.media_type, data: asString(source.data) });
      else if (source.type === 'url' && typeof source.url === 'string') images.push({ url: source.url });
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: asString(block.id), name: asString(block.name), arguments: JSON.stringify(block.input ?? {}) });
    } else if (block.type === 'tool_result') {
      toolResults.push({ toolCallId: asString(block.tool_use_id), name: null, text: textOf(block.content), isError: block.is_error === true });
    }
  }
  return { text: texts.join('\n'), images, toolCalls, toolResults };
}

export function parseAnthropicRequest(body: unknown): CanonRequest {
  const input = record(body);
  const system = textOf(input.system).trim() ? textOf(input.system) : null;
  const messages: CanonMessage[] = (Array.isArray(input.messages) ? input.messages : []).map((raw: unknown) => {
    const msg = record(raw);
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    return { ...emptyMessage(role), ...anthropicContent(msg.content) };
  });
  const tools: CanonTool[] = (Array.isArray(input.tools) ? input.tools : []).map((raw: unknown) => {
    const tool = record(raw);
    return { name: asString(tool.name), description: nullableString(tool.description), schema: tool.input_schema == null ? null : tool.input_schema as Json };
  });
  return {
    system,
    messages,
    tools,
    maxTokens: numberOrNull(input.max_tokens),
    stops: Array.isArray(input.stop_sequences) ? input.stop_sequences.filter((item: unknown): item is string => typeof item === 'string') : [],
    jsonMode: false,
    stream: input.stream === true,
    temperature: numberOrNull(input.temperature),
  };
}

function openAIMessage(message: CanonMessage): Record<string, unknown>[] {
  if (message.role === 'system') return [{ role: 'system', content: message.text }];
  if (message.role === 'tool') return message.toolResults.map(result => ({ role: 'tool', tool_call_id: result.toolCallId, content: result.text }));
  if (message.role === 'user') {
    const content = message.images.length === 0 ? message.text : [
      ...(message.text ? [{ type: 'text', text: message.text }] : []),
      ...message.images.map(image => ({ type: 'image_url', image_url: { url: 'url' in image ? image.url : `data:${image.mediaType};base64,${image.data}` } })),
    ];
    return [{ role: 'user', content }];
  }
  const result: Record<string, unknown> = { role: 'assistant', content: message.text || null };
  if (message.toolCalls.length) result.tool_calls = message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
  return [result];
}

export function renderOpenAIRequest(canon: CanonRequest, model: string): { path: string; body: Json } {
  const body: Record<string, unknown> = {
    model,
    messages: [...(canon.system !== null ? [{ role: 'system', content: canon.system }] : []), ...canon.messages.flatMap(openAIMessage)],
    stream: canon.stream,
  };
  if (canon.tools.length) body.tools = canon.tools.map(tool => ({ type: 'function', function: { name: tool.name, ...(tool.description !== null ? { description: tool.description } : {}), ...(tool.schema !== null ? { parameters: tool.schema } : {}) } }));
  if (canon.maxTokens !== null) body.max_tokens = canon.maxTokens;
  if (canon.stops.length) body.stop = canon.stops;
  if (canon.jsonMode) body.response_format = { type: 'json_object' };
  if (canon.temperature !== null) body.temperature = canon.temperature;
  if (canon.stream) body.stream_options = { include_usage: true };
  return { path: '/v1/chat/completions', body: body as Json };
}

function parseArguments(argumentsText: string): unknown {
  try { return JSON.parse(argumentsText); } catch { return {}; }
}

function anthropicMessage(message: CanonMessage): Record<string, unknown>[] {
  let role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
  const blocks: Record<string, unknown>[] = [];
  if (message.text) blocks.push({ type: 'text', text: message.text });
  for (const image of message.images) blocks.push({ type: 'image', source: 'url' in image ? { type: 'url', url: image.url } : { type: 'base64', media_type: image.mediaType, data: image.data } });
  if (role === 'assistant') {
    for (const call of message.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.arguments) });
  } else {
    for (const result of message.toolResults) blocks.push({ type: 'tool_result', tool_use_id: result.toolCallId, content: result.text, ...(result.isError ? { is_error: true } : {}) });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return [{ role, content: blocks }];
}

export function renderAnthropicRequest(canon: CanonRequest, model: string): { path: string; body: Json } {
  const body: Record<string, unknown> = { model, messages: canon.messages.flatMap(anthropicMessage), stream: canon.stream };
  if (canon.system !== null) body.system = canon.system;
  if (canon.tools.length) body.tools = canon.tools.map(tool => ({ name: tool.name, ...(tool.description !== null ? { description: tool.description } : {}), ...(tool.schema !== null ? { input_schema: tool.schema } : {}) }));
  if (canon.maxTokens !== null) body.max_tokens = canon.maxTokens;
  if (canon.stops.length) body.stop_sequences = canon.stops;
  if (canon.temperature !== null) body.temperature = canon.temperature;
  return { path: '/v1/messages', body: body as Json };
}

function geminiMessage(message: CanonMessage): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (message.text) parts.push({ text: message.text });
  for (const image of message.images) parts.push('url' in image ? { fileData: { fileUri: image.url } } : { inlineData: { mimeType: image.mediaType, data: image.data } });
  for (const call of message.toolCalls) parts.push({ functionCall: { name: call.name, args: parseArguments(call.arguments) } });
  for (const result of message.toolResults) parts.push({ functionResponse: { name: result.name ?? 'tool', response: { result: result.text } } });
  if (!parts.length) parts.push({ text: '' });
  return { role: message.role === 'assistant' ? 'model' : 'user', parts };
}

export function renderGeminiRequest(canon: CanonRequest, model: string): { path: string; body: Json } {
  const body: Record<string, unknown> = { contents: canon.messages.map(geminiMessage) };
  if (canon.system !== null) body.systemInstruction = { parts: [{ text: canon.system }] };
  if (canon.tools.length) body.tools = [{ functionDeclarations: canon.tools.map(tool => ({ name: tool.name, ...(tool.description !== null ? { description: tool.description } : {}), ...(tool.schema !== null ? { parameters: tool.schema } : {}) })) }];
  const generationConfig: Record<string, unknown> = {};
  if (canon.maxTokens !== null) generationConfig.maxOutputTokens = canon.maxTokens;
  if (canon.stops.length) generationConfig.stopSequences = canon.stops;
  if (canon.temperature !== null) generationConfig.temperature = canon.temperature;
  if (canon.jsonMode) generationConfig.responseMimeType = 'application/json';
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return { path: `/v1beta/models/${model}${canon.stream ? ':streamGenerateContent' : ':generateContent'}`, body: body as Json };
}

export function renderRequest(wire: Wire, canon: CanonRequest, model: string): { path: string; body: Json } {
  switch (String(wire).toLowerCase()) {
    case 'openai':
    case 'open_ai':
    case 'openai-compatible':
      return renderOpenAIRequest(canon, model);
    case 'anthropic':
      return renderAnthropicRequest(canon, model);
    case 'gemini':
    case 'google':
      return renderGeminiRequest(canon, model);
    default:
      throw new Error(`Unsupported provider wire: ${String(wire)}`);
  }
}
