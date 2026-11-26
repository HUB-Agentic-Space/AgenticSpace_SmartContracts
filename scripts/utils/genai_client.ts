/**
 * genai_client.ts
 * ---------------
 * Shared GenAI completion client for CAS analysis scripts: tries the
 * OpenRouter model chain first (AI_MODEL + catalog-verified :free
 * fallbacks) and short-circuits to the local Ollama daemon when the
 * account cannot pay — the first credit/quota error (HTTP 402/429 or
 * "insufficient credits" in the body) jumps straight to Ollama instead
 * of burning attempts on the remaining free models.
 *
 * Local Ollama candidates are discovered via GET /api/tags and ranked
 * with the best local chat model first (parameter size desc, embedding
 * families and remote `*:cloud` models excluded), honoring OLLAMA_MODEL
 * as the second candidate when explicitly configured.
 *
 * Environment:
 *   AI_API_KEY       OpenRouter API key (optional — Ollama still tried)
 *   AI_MODEL         Primary OpenRouter model (optional)
 *   OLLAMA_BASE_URL  Ollama daemon base URL (fallback: OLLAMA_URL, then
 *                    http://localhost:11434)
 *   OLLAMA_MODEL     Explicit local model preference (optional)
 *
 * Model IDs verified against https://openrouter.ai/api/v1/models on
 * 2026-11. Free variants rotate — keep this list refreshable.
 *
 * Author: Carlos Delfino
 * Email: consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

// ── Model catalog ─────────────────────────────────────────────────────

/**
 * OpenRouter fallback chain after AI_MODEL.
 * All `:free` entries were verified against the public model catalog;
 * `deepseek/deepseek-r1-0528` is the only paid entry (the `:free`
 * variant was removed from the catalog) and stays last so it only runs
 * when the account has credits — it fails fast otherwise and the chain
 * continues to Ollama.
 */
export const OPENROUTER_FALLBACK_MODELS: readonly string[] = [
  "openrouter/free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "baidu/ernie-5.5-flash-preview:free",
  "inclusionai/ling-3.2-flash:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "thinkingmachines/inkling-2-small:free",
  "deepseek/deepseek-r1-0528",
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = 60_000;
const OLLAMA_TAGS_TIMEOUT_MS = 10_000;
const OLLAMA_CHAT_TIMEOUT_MS = 180_000;
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

// ── Types ─────────────────────────────────────────────────────────────

export interface GenAiLogger {
  (level: "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG", fn: string, message: string, params?: Record<string, unknown>): void;
}

export interface GenAiRequest {
  /** Full prompt sent as a single `user` message. */
  prompt: string;
  /** Max tokens to generate (OpenRouter `max_tokens` / Ollama `num_predict`). Default 4096. */
  maxTokens?: number;
  /**
   * Minimum acceptable response size in characters. Smaller answers are
   * treated as provider failures so the chain moves to the next model —
   * protects callers against answers that look truncated (e.g. reasoning
   * models burning the token budget on thinking, or terse replies to
   * multi-section prompts). Default 0 (no minimum).
   */
  minContentChars?: number;
  /** Sampling temperature. Default 0.3. */
  temperature?: number;
  /** `X-Title` header identifying the calling report to OpenRouter. */
  title?: string;
  /** Structured logger following the project logging rule. */
  log?: GenAiLogger;
}

export interface GenAiResult {
  /** Generated text (markdown fences already stripped). */
  content: string;
  /** Provider that answered: remote OpenRouter or local Ollama. */
  provider: "openrouter" | "ollama";
  /** Exact model identifier that produced the answer. */
  model: string;
}

/**
 * Model entry as returned by Ollama GET /api/tags. `parameter_size`
 * uses compact suffixes ("32.2B", "475M"); `remote_host` is set for
 * `*:cloud` models served by ollama.com (excluded — not local).
 */
export interface OllamaModelTag {
  name: string;
  size?: number;
  remote_host?: string;
  details?: {
    parameter_size?: string;
    family?: string;
    families?: string[];
  };
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ── Pure helpers (unit-testable) ──────────────────────────────────────

/**
 * True when an OpenRouter failure means the account cannot pay for the
 * request at all — HTTP 402 (payment required), HTTP 429 (quota/rate
 * limit) or a body mentioning insufficient credits/quota/rate limit.
 * These errors cannot be fixed by trying another model, so the caller
 * short-circuits to the local Ollama fallback.
 *
 * @param status - HTTP status code (0 for network-level errors).
 * @param body   - response body excerpt (lower-cased internally).
 * @returns whether the chain should jump straight to Ollama.
 */
export function isCreditOrQuotaError(status: number, body: string): boolean {
  if (status === 402 || status === 429) return true;
  const b = body.toLowerCase();
  return (
    b.includes("insufficient") ||
    b.includes("credit") ||
    b.includes("quota") ||
    b.includes("rate limit")
  );
}

/**
 * Converts an Ollama `parameter_size` string ("32.2B", "475.29M", "1.6B")
 * to billions of parameters for ranking. Unknown formats return 0.
 */
export function parseParamSizeB(parameterSize: string | undefined): number {
  if (!parameterSize) return 0;
  const m = parameterSize.trim().match(/^([\d.]+)\s*([bmtkm]?)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return 0;
  const unit = m[2].toLowerCase();
  if (unit === "m") return n / 1000;
  if (unit === "t") return n * 1000;
  return n; // "b" or bare number ≈ billions
}

const EMBEDDING_FAMILY_RE = /bert|embed/i;

/**
 * True for models usable for chat generation: excludes embedding
 * families (bert, nomic-embed, mxbai, embeddinggemma), names containing
 * "embed", and remote `*:cloud` models (remote_host set) which need an
 * ollama.com account instead of running locally.
 */
/**
 * True when the provider reports the generation stopped because it hit
 * the output token limit — OpenRouter `finish_reason` and Ollama
 * `done_reason` both use "length". Truncated answers are treated as
 * provider failures so the chain moves to the next model instead of
 * embedding broken/incomplete HTML in the report.
 */
export function isTruncatedResponse(reason: string | undefined | null): boolean {
  return reason === "length";
}

export function isLocalChatModel(tag: OllamaModelTag): boolean {
  if (tag.remote_host) return false;
  if (/embed/i.test(tag.name)) return false;
  const family = (tag.details?.family ?? "").toLowerCase();
  const families = (tag.details?.families ?? []).map((f) => f.toLowerCase());
  const all = [family, ...families].filter(Boolean);
  if (all.some((f) => EMBEDDING_FAMILY_RE.test(f))) return false;
  return true;
}

/**
 * Picks the best locally installed chat model: the eligible candidate
 * with the largest parameter size (bigger models reason better for the
 * analytical prompts used here), `size` (bytes on disk) as tie-break.
 *
 * @param tags - entries from GET /api/tags.
 * @returns the best tag or null when nothing usable is installed.
 */
export function selectBestOllamaModel(tags: OllamaModelTag[]): OllamaModelTag | null {
  const chat = tags.filter(isLocalChatModel);
  if (chat.length === 0) return null;
  return [...chat].sort((a, b) => {
    const diff = parseParamSizeB(b.details?.parameter_size) - parseParamSizeB(a.details?.parameter_size);
    if (diff !== 0) return diff;
    return (b.size ?? 0) - (a.size ?? 0);
  })[0];
}

/**
 * Orders Ollama candidates for the fallback chain: the best local model
 * first (per the "melhor modelo local primeiro" requirement), then the
 * explicitly configured OLLAMA_MODEL when installed, then remaining chat
 * models by parameter size.
 *
 * @param tags      - entries from GET /api/tags.
 * @param preferred - OLLAMA_MODEL env value (may be unset or absent).
 * @returns deduplicated list of model names to try, in order.
 */
export function orderOllamaCandidates(tags: OllamaModelTag[], preferred?: string): string[] {
  const chat = tags.filter(isLocalChatModel);
  const sorted = [...chat].sort((a, b) => {
    const diff = parseParamSizeB(b.details?.parameter_size) - parseParamSizeB(a.details?.parameter_size);
    if (diff !== 0) return diff;
    return (b.size ?? 0) - (a.size ?? 0);
  });
  const best = selectBestOllamaModel(tags);
  const pref = preferred?.trim();
  const ordered: string[] = [];
  if (best) ordered.push(best.name);
  if (pref && chat.some((t) => t.name === pref) && !ordered.includes(pref)) ordered.push(pref);
  for (const t of sorted) {
    if (!ordered.includes(t.name)) ordered.push(t.name);
  }
  return ordered;
}

/**
 * Resolves the Ollama base URL from OLLAMA_BASE_URL, OLLAMA_URL or the
 * default localhost daemon — no trailing slash.
 */
export function resolveOllamaBaseUrl(): string {
  const raw =
    process.env.OLLAMA_BASE_URL?.trim() ||
    process.env.OLLAMA_URL?.trim() ||
    OLLAMA_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// ── HTTP helpers ──────────────────────────────────────────────────────

function noopLog(): void { /* log callback not provided */ }

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, body.slice(0, 300), `HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider calls ────────────────────────────────────────────────────

/**
 * Single OpenRouter chat completion. Throws HttpError on non-2xx (the
 * caller inspects status/body for credit errors) or Error on malformed
 * responses.
 */
async function callOpenRouter(
  apiKey: string,
  model: string,
  req: GenAiRequest,
  log: GenAiLogger,
): Promise<string> {
  log("INFO", "callOpenRouter", "Chamando OpenRouter", { model });
  const data = (await fetchJsonWithTimeout(OPENROUTER_URL, OPENROUTER_TIMEOUT_MS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agenticspace.rapport.tec.br",
      "X-Title": req.title ?? "Agentic Space CAS Analysis",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: req.prompt }],
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 4096,
    }),
  })) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; error?: { message?: string } };

  if (data.error?.message) {
    throw new Error(`OpenRouter error: ${data.error.message.slice(0, 200)}`);
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) throw new Error("Resposta vazia do modelo");
  assertUsableContent(content, choice?.finish_reason, req, "OpenRouter");
  log("OK", "callOpenRouter", "Resposta recebida", { model, chars: content.length });
  return stripCodeFences(content);
}

/**
 * Removes markdown code fences (```html, ```json, ``` … ```) that
 * models wrap around generated content. Applied to every provider
 * response before it reaches the caller.
 */
export function stripCodeFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*\n?/g, "").replace(/```/g, "").trim();
}

/**
 * When a model answers with a JSON object instead of the requested HTML
 * (structured-output fine-tunes do this), converts its entries into
 * `<h3>key</h3><p>value</p>` blocks — `<ul>` for array values. All text
 * is HTML-escaped. Returns null for non-JSON input so callers keep their
 * normal rendering path.
 */
export function tryJsonToHtml(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const blocks = Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
    if (typeof v === "string") return `<h3>${esc(k)}</h3><p>${esc(v)}</p>`;
    if (Array.isArray(v)) return `<h3>${esc(k)}</h3><ul>${v.map((i) => `<li>${esc(String(i))}</li>`).join("")}</ul>`;
    return `<h3>${esc(k)}</h3><p>${esc(JSON.stringify(v))}</p>`;
  });
  return blocks.length > 0 ? blocks.join("\n") : null;
}

/**
 * Rejects generated text that is unusable for the caller: either
 * truncated by the provider's token limit (finish/done reason
 * "length") or shorter than `req.minContentChars` when a minimum was
 * configured. Throws so the fallback chain moves to the next model.
 */
function assertUsableContent(
  content: string,
  stopReason: string | undefined,
  req: GenAiRequest,
  provider: string,
): void {
  if (isTruncatedResponse(stopReason)) {
    throw new Error(`Resposta truncada pelo limite de tokens no ${provider} (${content.length} chars)`);
  }
  const minChars = req.minContentChars ?? 0;
  if (minChars > 0 && content.length < minChars) {
    throw new Error(`Resposta insuficiente no ${provider} (${content.length} < ${minChars} chars)`);
  }
}

/**
 * Lists locally installed Ollama models via GET /api/tags. Returns an
 * empty array (never throws) when the daemon is down — the caller
 * simply has no local candidates.
 */
export async function listOllamaModels(baseUrl: string, log: GenAiLogger): Promise<OllamaModelTag[]> {
  try {
    const data = (await fetchJsonWithTimeout(`${baseUrl}/api/tags`, OLLAMA_TAGS_TIMEOUT_MS)) as {
      models?: OllamaModelTag[];
    };
    return data.models ?? [];
  } catch (err) {
    log("WARN", "listOllamaModels", "Ollama /api/tags indisponível", {
      baseUrl,
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Single Ollama chat completion via POST /api/chat (stream:false).
 * Throws on HTTP errors, empty responses or malformed payloads.
 */
async function callOllama(baseUrl: string, model: string, req: GenAiRequest, log: GenAiLogger): Promise<string> {
  log("INFO", "callOllama", "Chamando Ollama local", { model, baseUrl });
  const data = (await fetchJsonWithTimeout(`${baseUrl}/api/chat`, OLLAMA_CHAT_TIMEOUT_MS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: req.prompt }],
      stream: false,
      options: { temperature: req.temperature ?? 0.3, num_predict: req.maxTokens ?? 4096 },
    }),
  })) as { message?: { content?: string }; done_reason?: string };

  const content = data.message?.content?.trim();
  if (!content) throw new Error("Resposta vazia do Ollama");
  assertUsableContent(content, data.done_reason, req, "Ollama");
  log("OK", "callOllama", "Resposta recebida", { model, chars: content.length });
  return stripCodeFences(content);
}

// ── Fallback chain ────────────────────────────────────────────────────

/**
 * Generates a chat completion trying, in order:
 *
 * 1. OpenRouter: AI_MODEL (when set) + OPENROUTER_FALLBACK_MODELS.
 *    Per-model errors advance to the next entry; the first
 *    credit/quota error short-circuits to step 2.
 * 2. Ollama local: GET /api/tags → candidates ordered with the best
 *    local chat model first, then OLLAMA_MODEL, then the rest by size.
 *
 * Never throws — returns null when every provider fails so callers can
 * render their own graceful fallback message.
 *
 * @param req - prompt + sampling options + logger.
 * @returns generated content with provider/model provenance, or null.
 */
export async function generateCompletion(req: GenAiRequest): Promise<GenAiResult | null> {
  const log = req.log ?? noopLog;
  const apiKey = process.env.AI_API_KEY?.trim() ?? "";
  const primaryModel = process.env.AI_MODEL?.trim() ?? "";

  if (apiKey) {
    const modelsToTry = [...new Set([primaryModel, ...OPENROUTER_FALLBACK_MODELS].filter(Boolean))];
    for (const tryModel of modelsToTry) {
      try {
        const content = await callOpenRouter(apiKey, tryModel, req, log);
        return { content, provider: "openrouter", model: tryModel };
      } catch (err) {
        if (err instanceof HttpError && isCreditOrQuotaError(err.status, err.body)) {
          log("WARN", "generateCompletion", "Crédito/cota insuficiente no OpenRouter — indo direto para Ollama", {
            model: tryModel,
            status: err.status,
            detail: err.body.slice(0, 120),
          });
          break;
        }
        log("WARN", "generateCompletion", "Modelo OpenRouter falhou, tentando próximo", {
          model: tryModel,
          error: (err as Error).message.slice(0, 200),
        });
      }
    }
    log("WARN", "generateCompletion", "OpenRouter indisponível — tentando Ollama local");
  } else {
    log("INFO", "generateCompletion", "AI_API_KEY ausente — indo direto para Ollama local");
  }

  const baseUrl = resolveOllamaBaseUrl();
  const tags = await listOllamaModels(baseUrl, log);
  const candidates = orderOllamaCandidates(tags, process.env.OLLAMA_MODEL?.trim());

  if (candidates.length === 0) {
    log("ERROR", "generateCompletion", "Nenhum modelo de chat instalado no Ollama", { baseUrl });
    return null;
  }
  log("INFO", "generateCompletion", "Candidatos Ollama ordenados (melhor local primeiro)", {
    baseUrl,
    candidates: candidates.slice(0, 5),
  });

  for (const model of candidates) {
    try {
      const content = await callOllama(baseUrl, model, req, log);
      return { content, provider: "ollama", model };
    } catch (err) {
      log("WARN", "generateCompletion", "Modelo Ollama falhou, tentando próximo", {
        model,
        error: (err as Error).message.slice(0, 200),
      });
    }
  }

  log("ERROR", "generateCompletion", "Todos os provedores GenAI falharam");
  return null;
}
