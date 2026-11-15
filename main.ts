// EXSALA HERMES MOD · powered by Gienetic
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  capabilitiesOf,
  joinBase,
  meetsRequirements,
  modelFree,
  ratingOfModel,
  readBrief,
  type Brief,
  type CatalogReport,
  type Requirement,
} from './lib/providers.ts';
import {
  parseAnthropicRequest,
  parseOpenAIRequest,
  renderRequest,
  type CanonAnswer,
  type CanonRequest,
} from './lib/convert.ts';
import { parseProviderAnswer } from './lib/answers.ts';
import { renderModelsList, renderOpenAIAnswer } from './lib/wireOpenAI.ts';
import { renderAnthropicAnswer } from './lib/wireAnthropic.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE;
const EMPTY_CATALOG: CatalogReport['doc'] = { providers: [] };

interface Candidate {
  probe: CatalogReport['probes'][number];
  modelId: string;
  rating: number;
}

interface ClientResponse {
  status: number;
  contentType: string;
  body: string;
}

async function loadCatalog(): Promise<{ brief: Brief | null; report: CatalogReport | null }> {
  if (!PROMPT_FILE) return { brief: null, report: null };
  try {
    const brief = readBrief(PROMPT_FILE);
    const report = await buildCatalog(brief, ENV_URL ?? '');
    return { brief, report };
  } catch {
    return { brief: null, report: null };
  }
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function candidatesFor(
  brief: Brief,
  report: CatalogReport,
  requires: Requirement,
  canon: CanonRequest,
  clientApi: 'openai' | 'anthropic',
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const probe of report.probes) {
    if (probe.entry.wire === 'anthropic' && clientApi === 'openai' && canon.jsonMode) continue;
    let champion: Candidate | null = null;
    for (const model of probe.models) {
      const row = ratingOfModel(brief.ratings, probe.entry.id, model.id);
      if (!modelFree(model, row)) continue;
      const capabilities = capabilitiesOf(model, row);
      if (!meetsRequirements(requires, capabilities)) continue;
      if (champion === null || capabilities.rating > champion.rating) {
        champion = { probe, modelId: model.id, rating: capabilities.rating };
      }
    }
    if (champion !== null) candidates.push(champion);
  }
  return candidates.sort((left, right) => right.rating - left.rating);
}

async function attemptProviders(
  candidates: Candidate[],
  canon: CanonRequest,
  clientApi: 'openai' | 'anthropic',
  clientModel: string,
): Promise<ClientResponse | null> {
  for (const candidate of candidates) {
    const { probe, modelId } = candidate;
    try {
      const rendered = renderRequest(probe.entry.wire, canon, modelId);
      const response = await fetch(
        joinBase(ENV_URL ?? '', probe.entry.path) + rendered.path,
        {
          method: 'POST',
          headers: { ...authHeaders(probe.entry), 'content-type': 'application/json' },
          body: JSON.stringify(rendered.body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) continue;
      const answer: CanonAnswer = parseProviderAnswer(probe.entry.wire, contentType, text);
      const renderedAnswer = clientApi === 'openai'
        ? renderOpenAIAnswer(clientModel, answer, canon.stream)
        : renderAnthropicAnswer(clientModel, answer, canon.stream);
      return renderedAnswer;
    } catch {
      // Try the next provider on timeouts, network errors, or provider failures.
    }
  }
  return null;
}

async function handleInference(
  request: IncomingMessage,
  response: ServerResponse,
  clientApi: 'openai' | 'anthropic',
  brief: Brief | null,
  report: CatalogReport | null,
  nextRequest: () => number,
): Promise<void> {
  const requestNumber = nextRequest();
  try {
    const parsedBody: unknown = JSON.parse(await readRequestBody(request));
    const canon = clientApi === 'openai'
      ? parseOpenAIRequest(parsedBody)
      : parseAnthropicRequest(parsedBody);
    const bodyRecord = parsedBody !== null && typeof parsedBody === 'object'
      ? parsedBody as Record<string, unknown>
      : {};
    const clientModel = (bodyRecord.model ?? 'auto') as string;
    const workloadRow = brief?.workload.requests[requestNumber - 1];
    const requires = workloadRow && workloadRow.api === clientApi && workloadRow.stream === canon.stream
      ? workloadRow.requires
      : {};
    const candidates = brief && report
      ? candidatesFor(brief, report, requires, canon, clientApi)
      : [];
    const result = await attemptProviders(candidates, canon, clientApi, clientModel);
    if (result) {
      response.writeHead(result.status, { 'content-type': result.contentType });
      response.end(result.body);
      return;
    }
    if (clientApi === 'openai') {
      jsonResponse(response, 502, { error: { message: 'all providers failed', type: 'api_error' } });
    } else {
      jsonResponse(response, 502, { type: 'error', error: { type: 'api_error', message: 'all providers failed' } });
    }
  } catch {
    jsonResponse(response, 400, { error: { message: 'invalid request' } });
  }
}

async function run(): Promise<void> {
  const { brief, report } = await loadCatalog();
  if (process.argv.includes('--list')) {
    console.log(JSON.stringify(report?.doc ?? EMPTY_CATALOG));
    return;
  }

  const freeIds = report?.doc.providers.flatMap(provider =>
    provider.models.filter(model => model.free).map(model => model.id),
  ) ?? [];
  let inferenceCount = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/v1/models') {
      const api = request.headers['x-api-key'] !== undefined ? 'anthropic' : 'openai';
      jsonResponse(response, 200, renderModelsList(api, freeIds));
      return;
    }
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      void handleInference(request, response, 'openai', brief, report, () => ++inferenceCount);
      return;
    }
    if (request.method === 'POST' && path === '/v1/messages') {
      void handleInference(request, response, 'anthropic', brief, report, () => ++inferenceCount);
      return;
    }
    jsonResponse(response, 404, { error: { message: 'not found' } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine server port');

  if (!ENV_URL) return;
  await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port: address.port, catalog: report?.doc ?? EMPTY_CATALOG }),
  });

  while (true) {
    try {
      const response = await fetch(`${ENV_URL}/work`);
      const work: unknown = await response.json();
      if (work !== null && typeof work === 'object' && (work as { done?: unknown }).done === true) {
        server.close(() => process.exit(0));
        return;
      }
    } catch {
      // Keep polling at the requested interval if the environment is transiently unavailable.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

void run();
