// EXSALA HERMES MOD · powered by Gienetic
import type { CanonAnswer } from './convert.ts';

const CHUNK_SIZE = 24;

function stopReason(answer: CanonAnswer): string {
  const native = answer.stopNative;
  return native === 'max_tokens' || native === 'length' || native === 'MAX_TOKENS'
    ? 'max_tokens'
    : 'end_turn';
}

function splitPieces(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  return pieces;
}

function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function renderAnthropicAnswer(
  model: string,
  answer: CanonAnswer,
  stream: boolean,
): { status: number; contentType: string; body: string } {
  const sr = stopReason(answer);

  if (!stream) {
    const body = JSON.stringify({
      id: 'msg_agg',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: answer.text }],
      stop_reason: sr,
      stop_sequence: null,
      usage: {
        input_tokens: answer.inputTokens,
        output_tokens: answer.outputTokens,
      },
    });
    return { status: 200, contentType: 'application/json', body };
  }

  const frames: string[] = [];

  frames.push(
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_agg',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.inputTokens, output_tokens: 0 },
      },
    }),
  );

  frames.push(
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );

  for (const piece of splitPieces(answer.text, CHUNK_SIZE)) {
    frames.push(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: piece },
      }),
    );
  }

  frames.push(
    frame('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
  );

  frames.push(
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: sr, stop_sequence: null },
      usage: { output_tokens: answer.outputTokens },
    }),
  );

  frames.push(frame('message_stop', { type: 'message_stop' }));

  return {
    status: 200,
    contentType: 'text/event-stream',
    body: frames.join(''),
  };
}
