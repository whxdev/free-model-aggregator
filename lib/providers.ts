/**
 * EXSALA HERMES MOD · powered by Gienetic
 *
 * lib/providers.ts — brief parsing + provider catalog probing.
 *
 * The "brief" is a plain text file that carries three JSON documents, each
 * tagged by its `schema` member:
 *
 *   - providers  : the provider directory (id, wire flavour, auth scheme, key, path)
 *   - ratings    : per-(provider, model) quality/capability rows for free models
 *   - workload   : the ordered list of client requests the aggregator must serve
 *
 * This module is deliberately dependency free (Node 22 stdlib only) so it can
 * run under `node --experimental-strip-types`. Everything here is defensive:
 * the brief is treated as untrusted input and every field is normalised before
 * it reaches the rest of the pipeline.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types & schema constants
// ---------------------------------------------------------------------------

/** Upstream wire protocol spoken by a provider. */
export type Wire = 'openai' | 'anthropic' | 'gemini';

/** How a provider expects its credential to be presented. */
export type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

/** Which client-facing API surface a workload request arrives on. */
export type ClientApi = 'openai' | 'anthropic';

/** A plain JSON object. */
export type Json = Record<string, unknown>;

export const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
export const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
export const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

export interface ProviderDirectoryEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  /** Name of the environment variable that may carry the key. */
  key_env: string | null;
  /** The key itself, carried inline in the brief (absent when auth is "none"). */
  key: string | null;
  /** Local mount path, e.g. "/p/groq". */
  path: string;
}

export interface ProviderDirectory {
  schema: string;
  providers: ProviderDirectoryEntry[];
}

export interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

export interface RatingsFile {
  schema: string;
  rows: RatingRow[];
}

export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface WorkloadRequest {
  id: string;
  api: ClientApi;
  stream: boolean;
  weight: number;
  requires: Requirement;
}

export interface WorkloadFile {
  schema: string;
  requests: WorkloadRequest[];
}

/** The three documents of a brief, in canonical form. */
export interface Brief {
  directory: ProviderDirectory;
  ratings: RatingsFile;
  workload: WorkloadFile;
}

/** A model as reported by a live provider catalog listing. */
export interface ProbedModel {
  id: string;
  free: boolean | null;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

/** One provider probe attempt. */
export interface Probe {
  entry: ProviderDirectoryEntry;
  ok: boolean;
  models: ProbedModel[];
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string | null;
  wire: Wire;
  models: CatalogModel[];
}

export interface CatalogReport {
  doc: { providers: CatalogProvider[] };
  probes: Probe[];
}

/** Effective capabilities of a model, after the ratings row is folded in. */
export interface Capabilities {
  rating: number;
  contextLength: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

// ---------------------------------------------------------------------------
// Small normalisation helpers (the brief is untrusted input)
// ---------------------------------------------------------------------------

const WIRES: readonly Wire[] = ['openai', 'anthropic', 'gemini'];
const AUTH_SCHEMES: readonly AuthScheme[] = ['bearer', 'x-api-key', 'x-goog-api-key', 'none'];

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** String or `fallback` when the value is not a string. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Non-empty string, otherwise null. */
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Number via `Number(...)`, with NaN/non-finite collapsed to `fallback`. */
function numOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Number via `Number(...)`, with NaN/non-finite collapsed to null. */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Booleans are strict: only a real `true` counts. */
function bool(value: unknown): boolean {
  return value === true;
}

/** Boolean, or null when the value is not a boolean at all. */
function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Coerce into the Wire union, falling back to 'openai'. */
function toWire(value: unknown): Wire {
  return WIRES.includes(value as Wire) ? (value as Wire) : 'openai';
}

/** Coerce into the AuthScheme union, falling back to 'none'. */
function toAuth(value: unknown): AuthScheme {
  return AUTH_SCHEMES.includes(value as AuthScheme) ? (value as AuthScheme) : 'none';
}

/** Array or empty array. */
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Brief scanning
// ---------------------------------------------------------------------------

/**
 * Walk `text` character by character and return every balanced, top-level
 * `{...}` slice. String literals and their escapes are respected so braces
 * appearing inside JSON strings never disturb the depth counter, and nested
 * objects stay part of their outermost slice.
 */
function scanTopLevelObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      // Quotes in surrounding prose are not JSON strings; only track quoted
      // content once a top-level object has begun.
      if (depth > 0) inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          found.push(text.slice(start, i + 1));
          start = -1;
        }
      }
      continue;
    }
  }

  return found;
}

/** Parse one candidate slice, returning the object only when it has a string schema. */
function parseCandidate(slice: string): Json | null {
  try {
    const value: unknown = JSON.parse(slice);
    if (!isRecord(value)) return null;
    if (typeof value.schema !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document normalisers
// ---------------------------------------------------------------------------

function normalizeProviderEntry(raw: unknown): ProviderDirectoryEntry {
  const obj = isRecord(raw) ? raw : {};
  return {
    id: str(obj.id),
    name: str(obj.name),
    wire: toWire(obj.wire),
    auth: toAuth(obj.auth),
    key_env: typeof obj.key_env === 'string' ? obj.key_env : '',
    key: strOrNull(obj.key),
    path: str(obj.path),
  };
}

function normalizeProviderDirectory(doc: Json): ProviderDirectory {
  return {
    schema: str(doc.schema, PROVIDERS_SCHEMA),
    providers: arr(doc.providers).map(normalizeProviderEntry),
  };
}

function normalizeRatingRow(raw: unknown): RatingRow {
  const obj = isRecord(raw) ? raw : {};
  return {
    model: str(obj.model),
    provider: str(obj.provider),
    rating_milli: numOr(obj.rating_milli, 0),
    context_length: numOrNull(obj.context_length),
    tools: bool(obj.tools),
    vision: bool(obj.vision),
    json: bool(obj.json),
    free: bool(obj.free),
  };
}

function normalizeRatingsFile(doc: Json): RatingsFile {
  // The brief carries the array under "ratings"; "rows" is the legacy key.
  const rows = Array.isArray(doc.ratings) ? doc.ratings : arr(doc.rows);
  return {
    schema: str(doc.schema, RATINGS_SCHEMA),
    rows: rows.map(normalizeRatingRow),
  };
}

/** Copy only the four known requirement keys, each strictly normalised. */
function normalizeRequirement(raw: unknown): Requirement {
  const obj = isRecord(raw) ? raw : {};
  const requires: Requirement = {};

  if ('tools' in obj) requires.tools = bool(obj.tools);
  if ('vision' in obj) requires.vision = bool(obj.vision);
  if ('json' in obj) requires.json = bool(obj.json);

  if ('min_context' in obj) {
    const minContext = numOrNull(obj.min_context);
    if (minContext !== null) requires.min_context = minContext;
  }

  return requires;
}

function normalizeWorkloadRequest(raw: unknown): WorkloadRequest {
  const obj = isRecord(raw) ? raw : {};
  return {
    id: str(obj.id),
    api: obj.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: bool(obj.stream),
    weight: numOr(obj.weight, 0),
    requires: normalizeRequirement(obj.requires),
  };
}

function normalizeWorkloadFile(doc: Json): WorkloadFile {
  const requests = Array.isArray(doc.manifest) ? doc.manifest : arr(doc.requests);
  return {
    schema: str(doc.schema, WORKLOAD_SCHEMA),
    requests: requests.map(normalizeWorkloadRequest),
  };
}

/**
 * Locate and normalise the three brief documents inside arbitrary text
 * (markdown fences, prose, surrounding comments — all fine).
 */
export function parseBrief(text: string, source = 'brief'): Brief {
  const bySchema = new Map<string, Json>();

  for (const slice of scanTopLevelObjects(text)) {
    const candidate = parseCandidate(slice);
    if (candidate === null) continue;
    const schema = candidate.schema as string;
    // First occurrence wins; duplicates are ignored.
    if (!bySchema.has(schema)) bySchema.set(schema, candidate);
  }

  const providersDoc = bySchema.get(PROVIDERS_SCHEMA);
  if (!providersDoc) {
    throw new Error(`${source}: missing document with schema "${PROVIDERS_SCHEMA}"`);
  }

  const ratingsDoc = bySchema.get(RATINGS_SCHEMA);
  if (!ratingsDoc) {
    throw new Error(`${source}: missing document with schema "${RATINGS_SCHEMA}"`);
  }

  const workloadDoc = bySchema.get(WORKLOAD_SCHEMA);
  if (!workloadDoc) {
    throw new Error(`${source}: missing document with schema "${WORKLOAD_SCHEMA}"`);
  }

  return {
    directory: normalizeProviderDirectory(providersDoc),
    ratings: normalizeRatingsFile(ratingsDoc),
    workload: normalizeWorkloadFile(workloadDoc),
  };
}

/** Read a brief file from disk (utf8) and parse it. */
export function readBrief(path: string): Brief {
  const text = readFileSync(path, 'utf8');
  return parseBrief(text, path);
}

// ---------------------------------------------------------------------------
// Ratings / capability resolution
// ---------------------------------------------------------------------------

/** The ratings row for a (provider, model) pair, or null. */
export function ratingOfModel(
  ratings: RatingsFile,
  providerId: string,
  modelId: string,
): RatingRow | null {
  for (const row of ratings.rows) {
    if (row.provider === providerId && row.model === modelId) return row;
  }
  return null;
}

/**
 * Whether a model is free: the ratings row is authoritative when present,
 * otherwise fall back to what the listing claimed, otherwise not free.
 */
export function modelFree(model: ProbedModel, row: RatingRow | null): boolean {
  if (row) return row.free === true;
  if (typeof model.free === 'boolean') return model.free;
  return false;
}

/** Effective capabilities: the ratings row wins over the raw listing. */
export function capabilitiesOf(model: ProbedModel, row: RatingRow | null): Capabilities {
  if (row) {
    return {
      rating: row.rating_milli,
      contextLength: row.context_length,
      tools: row.tools === true,
      vision: row.vision === true,
      json: row.json === true,
    };
  }
  return {
    rating: 0,
    contextLength: model.context_length,
    tools: model.tools === true,
    vision: model.vision === true,
    json: model.json === true,
  };
}

/** True when the model satisfies every stated requirement. */
export function meetsRequirements(requires: Requirement, capabilities: Capabilities): boolean {
  if (requires.tools === true && !capabilities.tools) return false;
  if (requires.vision === true && !capabilities.vision) return false;
  if (requires.json === true && !capabilities.json) return false;

  if (typeof requires.min_context === 'number') {
    if (capabilities.contextLength === null) return false;
    if (capabilities.contextLength < requires.min_context) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// URL + header construction
// ---------------------------------------------------------------------------

const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * Join the aggregator's base URL with a provider mount path. An absolute
 * http(s) path is passed through untouched.
 */
export function joinBase(envUrl: string, base: string): string {
  if (ABSOLUTE_URL.test(base)) return base;

  const trimmedEnv = envUrl.replace(/\/+$/, '');
  const normalizedBase = base.startsWith('/') ? base : `/${base}`;
  return `${trimmedEnv}${normalizedBase}`;
}

/**
 * Credential headers for a provider. Wires that speak the Anthropic protocol
 * additionally need the anthropic-version header.
 */
export function authHeaders(entry: ProviderDirectoryEntry): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = entry.key;

  if (key !== null && key !== '' && entry.auth !== 'none') {
    switch (entry.auth) {
      case 'bearer':
        headers.authorization = `Bearer ${key}`;
        break;
      case 'x-api-key':
        headers['x-api-key'] = key;
        break;
      case 'x-goog-api-key':
        headers['x-goog-api-key'] = key;
        break;
      default:
        break;
    }
  }

  if (entry.wire === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Catalog probing
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 10_000;

/** Strip a leading "models/" segment from a Gemini resource name. */
function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/** Map one listing item onto a ProbedModel (wire-specific id/context rules). */
function toProbedModel(wire: Wire, raw: unknown): ProbedModel | null {
  if (!isRecord(raw)) return null;

  let id: string;
  if (wire === 'gemini') {
    const explicitId = strOrNull(raw.id);
    const nameId = stripModelsPrefix(str(raw.name));
    id = explicitId ?? nameId;
  } else {
    id = str(raw.id);
  }

  if (id === '') return null;

  // context_length may arrive camelCased; Gemini also uses inputTokenLimit.
  const rawContext = wire === 'gemini'
    ? (raw.context_length ?? raw.contextLength ?? raw.inputTokenLimit)
    : (raw.context_length ?? raw.contextLength);

  return {
    id,
    free: boolOrNull(raw.free),
    context_length: numOrNull(rawContext),
    tools: boolOrNull(raw.tools),
    vision: boolOrNull(raw.vision),
    json: boolOrNull(raw.json),
  };
}

/** Tolerant extraction of a model list from a catalog listing body. */
function extractModels(wire: Wire, body: unknown): ProbedModel[] {
  if (!isRecord(body)) return [];

  const items: unknown[] = wire === 'gemini' ? arr(body.models) : arr(body.data);
  const models: ProbedModel[] = [];

  for (const item of items) {
    const model = toProbedModel(wire, item);
    if (model !== null) models.push(model);
  }

  return models;
}

/** Probe one provider's catalog. Never throws: failure becomes ok:false. */
async function probeEntry(entry: ProviderDirectoryEntry, envUrl: string): Promise<Probe> {
  const suffix = entry.wire === 'gemini' ? '/v1beta/models' : '/v1/models';
  const url = `${joinBase(envUrl, entry.path)}${suffix}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: authHeaders(entry),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { entry, ok: false, models: [] };
    }

    const body: unknown = await response.json();
    return { entry, ok: true, models: extractModels(entry.wire, body) };
  } catch {
    // Network error, timeout, malformed JSON — all treated as a dead probe.
    return { entry, ok: false, models: [] };
  }
}

/**
 * Probe every provider in the brief (sequentially, in brief order) and build
 * the aggregated catalog document plus the raw probe log.
 */
export async function buildCatalog(brief: Brief, envUrl: string): Promise<CatalogReport> {
  const probes: Probe[] = [];

  // Sequential by design: a slow or hanging provider must not fan out.
  for (const entry of brief.directory.providers) {
    probes.push(await probeEntry(entry, envUrl));
  }

  const providers: CatalogProvider[] = brief.directory.providers.map((entry, index) => {
    const probe = probes[index];
    const probedModels = probe ? probe.models : [];

    const models: CatalogModel[] = probedModels.map((model) => {
      const row = ratingOfModel(brief.ratings, entry.id, model.id);
      return {
        id: model.id,
        free: modelFree(model, row),
        // The ratings row's context wins; otherwise trust the listing.
        context_length: row ? row.context_length : model.context_length,
      };
    });

    // Lexicographic ascending by id.
    models.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    return {
      id: entry.id,
      base_url: entry.path,
      key_env: entry.key_env,
      wire: entry.wire,
      models,
    };
  });

  return { doc: { providers }, probes };
}
