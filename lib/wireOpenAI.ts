import type { CanonAnswer } from './convert.ts'

const CREATED = 1767225600

type Api = 'openai' | 'anthropic'

export function renderOpenAIAnswer(
  model: string,
  answer: CanonAnswer,
  stream: boolean,
): { status: number; contentType: string; body: string } {
  const finishReason = ['length', 'max_tokens', 'MAX_TOKENS'].includes(answer.stopNative)
    ? 'length'
    : 'stop'
  const usage = {
    prompt_tokens: answer.inputTokens,
    completion_tokens: answer.outputTokens,
    total_tokens: answer.inputTokens + answer.outputTokens,
  }

  if (!stream) {
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'chatcmpl-agg',
        object: 'chat.completion',
        created: CREATED,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: answer.text },
            finish_reason: finishReason,
          },
        ],
        usage,
      }),
    }
  }

  const frames = [
    {
      id: 'chatcmpl-agg',
      object: 'chat.completion.chunk',
      created: CREATED,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
  ]

  for (let offset = 0; offset < answer.text.length; offset += 24) {
    frames.push({
      id: 'chatcmpl-agg',
      object: 'chat.completion.chunk',
      created: CREATED,
      model,
      choices: [
        {
          index: 0,
          delta: { content: answer.text.slice(offset, offset + 24) },
          finish_reason: null,
        },
      ],
    })
  }

  const events = [
    ...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
    `data: ${JSON.stringify({
      id: 'chatcmpl-agg',
      object: 'chat.completion.chunk',
      created: CREATED,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-agg',
      object: 'chat.completion.chunk',
      created: CREATED,
      model,
      choices: [],
      usage,
    })}\n\n`,
    'data: [DONE]\n\n',
  ]

  return { status: 200, contentType: 'text/event-stream', body: events.join('') }
}

export function renderModelsList(api: Api, ids: string[]) {
  if (api === 'openai') {
    return {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', created: CREATED, owned_by: 'aggregator' })),
    }
  }

  return {
    data: ids.map((id) => ({
      type: 'model',
      id,
      display_name: id,
      created_at: '2026-01-01T00:00:00Z',
    })),
    has_more: false,
    first_id: ids[0] ?? null,
    last_id: ids[ids.length - 1] ?? null,
  }
}
