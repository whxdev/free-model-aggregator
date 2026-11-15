// EXSALA HERMES MOD · powered by Gienetic
import type { CanonAnswer } from './convert.ts';
import type { Wire } from './providers.ts';

const EMPTY: CanonAnswer = { text: '', inputTokens: 0, outputTokens: 0, stopNative: null };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function joinTextParts(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const p of parts as any[]) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    if (p && typeof p === 'object' && typeof p.text === 'string') out += p.text;
  }
  return out;
}

/** Split a fully buffered SSE stream into parsed JSON payloads (order preserved). */
function sseData(text: string): unknown[] {
  const frames: unknown[] = [];
  if (typeof text !== 'string' || text.length === 0) return frames;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const block of normalized.split(/\n\n+/)) {
    const lines = block.split('\n');
    const dataLines: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trimStart();
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // unparseable frame — skip
    }
  }
  return frames;
}

export function parseOpenAIAnswerJson(body: unknown): CanonAnswer {
  const choices = (body as any)?.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : joinTextParts(content);
  const usage = (body as any)?.usage;
  return {
    text,
    inputTokens: num(usage?.prompt_tokens),
    outputTokens: num(usage?.completion_tokens),
    stopNative: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

export function parseAnthropicAnswerJson(body: unknown): CanonAnswer {
  const blocks = (body as any)?.content;
  let text = '';
  if (Array.isArray(blocks)) {
    for (const b of blocks as any[]) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') text += b.text;
    }
  }
  const usage = (body as any)?.usage;
  return {
    text,
    inputTokens: num(usage?.input_tokens),
    outputTokens: num(usage?.output_tokens),
    stopNative: typeof (body as any)?.stop_reason === 'string' ? (body as any).stop_reason : null,
  };
}

export function parseGeminiAnswerJson(body: unknown): CanonAnswer {
  const candidate = (body as any)?.candidates?.[0];
  const text = joinTextParts(candidate?.content?.parts);
  const usage = (body as any)?.usageMetadata;
  return {
    text,
    inputTokens: num(usage?.promptTokenCount),
    outputTokens: num(usage?.candidatesTokenCount),
    stopNative: typeof candidate?.finishReason === 'string' ? candidate.finishReason : null,
  };
}

export function parseOpenAIAnswerSse(text: string): CanonAnswer {
  const frames = sseData(text);
  let out = '';
  let stopNative: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const frame of frames) {
    const f = frame as any;
    if (!f || typeof f !== 'object') continue;
    const choices = f.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0];
      const deltaContent = choice?.delta?.content;
      if (typeof deltaContent === 'string') out += deltaContent;
      else if (Array.isArray(deltaContent)) out += joinTextParts(deltaContent);
      const fr = choice?.finish_reason;
      if (typeof fr === 'string') stopNative = fr;
    } else if (Array.isArray(choices) && choices.length === 0 && f.usage && typeof f.usage === 'object') {
      inputTokens = num(f.usage.prompt_tokens);
      outputTokens = num(f.usage.completion_tokens);
    }
  }
  return { text: out, inputTokens, outputTokens, stopNative };
}

export function parseAnthropicAnswerSse(text: string): CanonAnswer {
  const frames = sseData(text);
  let out = '';
  let stopNative: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const frame of frames) {
    const f = frame as any;
    if (!f || typeof f !== 'object') continue;
    switch (f.type) {
      case 'message_start': {
        const u = f.message?.usage;
        if (u && typeof u === 'object') inputTokens = num(u.input_tokens);
        break;
      }
      case 'content_block_delta': {
        const d = f.delta;
        if (d && typeof d === 'object' && d.type === 'text_delta' && typeof d.text === 'string') out += d.text;
        break;
      }
      case 'message_delta': {
        const u = f.usage;
        if (u && typeof u === 'object') outputTokens = num(u.output_tokens);
        if (typeof f.delta?.stop_reason === 'string') stopNative = f.delta.stop_reason;
        break;
      }
      default:
        break;
    }
  }
  return { text: out, inputTokens, outputTokens, stopNative };
}

export function parseGeminiAnswerSse(text: string): CanonAnswer {
  const frames = sseData(text);
  let out = '';
  let stopNative: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const frame of frames) {
    const f = frame as any;
    if (!f || typeof f !== 'object') continue;
    out += joinTextParts(f.candidates?.[0]?.content?.parts);
    const fr = f.candidates?.[0]?.finishReason;
    if (typeof fr === 'string') stopNative = fr;
    const u = f.usageMetadata;
    if (u && typeof u === 'object') {
      inputTokens = num(u.promptTokenCount);
      outputTokens = num(u.candidatesTokenCount);
    }
  }
  return { text: out, inputTokens, outputTokens, stopNative };
}

export function parseProviderAnswer(wire: Wire, contentType: string, text: string): CanonAnswer {
  const isSse = typeof contentType === 'string' && contentType.includes('text/event-stream');
  if (isSse) {
    if (wire === 'openai') return parseOpenAIAnswerSse(text);
    if (wire === 'anthropic') return parseAnthropicAnswerSse(text);
    if (wire === 'gemini') return parseGeminiAnswerSse(text);
    return { ...EMPTY };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...EMPTY };
  }
  if (wire === 'openai') return parseOpenAIAnswerJson(body);
  if (wire === 'anthropic') return parseAnthropicAnswerJson(body);
  if (wire === 'gemini') return parseGeminiAnswerJson(body);
  return { ...EMPTY };
}
