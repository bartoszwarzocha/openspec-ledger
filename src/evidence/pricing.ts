/**
 * Per-model prices and the cost arithmetic over one message's usage.
 *
 * Vendored from `E:/AI/claude-statusbar/src/pricing.ts`, copied 2026-09-04.
 *
 * design.md D10: the table is duplicated rather than shared. Two extensions do
 * not justify publishing and versioning a package, and the coupling would slow
 * both down. What is duplicated is a table of numbers carrying a dated
 * provenance comment, so when it drifts it drifts visibly.
 *
 * Prices are USD per million tokens, taken from
 * <https://platform.claude.com/docs/en/about-claude/pricing> and verified on
 * 2026-07-26 in the source project.
 *
 * Everything here produces a local *estimate*. It is not a billed figure, and
 * every surface that shows it says so.
 */

import type { MessageUsage, ModelPricing } from '../model/types.ts';
import { log } from '../util/log.ts';

/**
 * Build an entry from base input/output rates.
 *
 * The cache multipliers are fixed relative to the base input price: a 5-minute
 * cache write costs 1.25x, a 1-hour write 2x, and a cache read 0.1x.
 */
function rates(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
  };
}

/**
 * Keys are matched as *prefixes* of the model id, longest first, so dated
 * snapshots (`claude-opus-4-5-20251101`) and suffixed variants
 * (`claude-sonnet-4-5-20250929[1m]`) resolve to the right entry.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // --- Fable / Mythos tier: $10 / $50 ---
  'claude-fable-5': rates(10, 50),
  'claude-mythos-5': rates(10, 50),
  'claude-mythos-preview': rates(10, 50),

  // --- Opus 4.5 and later: $5 / $25 ---
  'claude-opus-5': rates(5, 25),
  'claude-opus-4-8': rates(5, 25),
  'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25),
  'claude-opus-4-5': rates(5, 25),

  // --- Legacy Opus: $15 / $75 ---
  'claude-opus-4-1': rates(15, 75),
  'claude-opus-4': rates(15, 75),
  'claude-3-opus': rates(15, 75),

  // --- Sonnet 5: introductory $2 / $10 through 2026-08-31, then $3 / $15 ---
  // The window is applied in getModelPricing(); this entry is the standard rate.
  'claude-sonnet-5': rates(3, 15),

  // --- Sonnet: $3 / $15 ---
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15),
  'claude-sonnet-4': rates(3, 15),
  'claude-3-7-sonnet': rates(3, 15),
  'claude-3-5-sonnet': rates(3, 15),
  'claude-3-sonnet': rates(3, 15),

  // --- Haiku ---
  'claude-haiku-4-5': rates(1, 5),
  'claude-3-5-haiku': rates(0.8, 4),
  'claude-3-haiku': rates(0.25, 1.25),
};

/** Sonnet 5 introductory pricing, in force up to but not including this instant. */
const SONNET_5_INTRO_PRICING = rates(2, 10);
const SONNET_5_INTRO_ENDS = Date.parse('2026-09-01T00:00:00Z');

/** Fast mode (research preview) reprices Opus 5 and Opus 4.8, flagged by `usage.speed`. */
const FAST_MODE_PRICING = rates(10, 50);
const FAST_MODE_MODELS = ['claude-opus-5', 'claude-opus-4-8'];

/** US-only inference (`inference_geo: "us"`) applies 1.1x across every category. */
const US_GEO_MULTIPLIER = 1.1;

/** Web search is billed at $10 per 1,000 requests, independently of the tokens. */
const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;

/** Sorted longest-first so `claude-opus-4-5` wins over `claude-opus-4`. */
const PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/** One log line per unrecognised model id, not one per message. */
const reportedModels = new Set<string>();

/**
 * Lowercase and strip cloud-provider prefixes:
 * `us.anthropic.claude-opus-5-v1:0` -> `claude-opus-5-v1:0`.
 */
export function normalizeModelId(id: string): string {
  let normalized = id.trim().toLowerCase();
  normalized = normalized.replace(/^(us|eu|apac|global)\./, '');
  normalized = normalized.replace(/^anthropic\./, '');
  normalized = normalized.replace(/^(bedrock|vertex|vertex_ai|foundry)\//, '');
  return normalized;
}

/**
 * Resolve prices for one model id, honouring the introductory window and fast
 * mode. Null means the id could not be priced at all, which the caller reports
 * as unpriced rather than as a cost of zero it measured.
 *
 * `at` is the moment the message was sent, not the moment of the scan: a
 * transcript from August must be priced with August's rates.
 */
export function getModelPricing(
  model: string | undefined,
  usage?: MessageUsage,
  at: Date = new Date(),
): ModelPricing | null {
  if (!model) {
    // No model recorded and nothing to name in the unpriced list either. Guessing
    // a tier here would put an invented number next to measured ones.
    return null;
  }

  const id = normalizeModelId(model);
  if (id.startsWith('<')) {
    return null;
  }

  const key = PRICING_KEYS.find((candidate) => id.startsWith(candidate));

  if (usage?.speed === 'fast' && key !== undefined && FAST_MODE_MODELS.includes(key)) {
    return FAST_MODE_PRICING;
  }

  let pricing: ModelPricing | undefined;
  if (key === 'claude-sonnet-5' && at.getTime() < SONNET_5_INTRO_ENDS) {
    pricing = SONNET_5_INTRO_PRICING;
  } else if (key !== undefined) {
    pricing = MODEL_PRICING[key];
  }

  if (pricing) {
    return pricing;
  }

  // The source project falls back to family-tier rates here, which suits a
  // status bar that would rather show a rough number than none. This extension
  // has the opposite rule: the spec says an id matching no entry contributes
  // zero and is listed as unpriced, because a cost sitting beside evidence has
  // to be traceable to a published price or visibly absent. A guessed figure
  // would be indistinguishable from a measured one.
  report(id, `no price entry for model "${id}"; its tokens are reported as unpriced`);
  return null;
}

function report(id: string, message: string): void {
  if (reportedModels.has(id)) {
    return;
  }
  reportedModels.add(id);
  log.info(message);
}

/**
 * Split cache-creation tokens into the 5-minute and 1-hour buckets.
 *
 * Claude Code writes 1-hour cache entries almost exclusively and those cost 2x
 * base input rather than 1.25x, so the split is worth honouring. Older
 * transcripts carry only the total, which is treated as a 5-minute write.
 */
export function splitCacheCreation(usage: MessageUsage): { write5m: number; write1h: number } {
  const total = usage.cache_creation_input_tokens || 0;
  const breakdown = usage.cache_creation;

  if (!breakdown) {
    return { write5m: total, write1h: 0 };
  }

  const write5m = breakdown.ephemeral_5m_input_tokens || 0;
  const write1h = breakdown.ephemeral_1h_input_tokens || 0;

  // A present but empty breakdown alongside a non-zero total: trust the total.
  if (write5m === 0 && write1h === 0 && total > 0) {
    return { write5m: total, write1h: 0 };
  }

  return { write5m, write1h };
}

/**
 * Estimate the cost of one message, counting every token category plus server
 * tool charges, with the 1.1x multiplier applied when inference ran US-only.
 */
export function calculateMessageCost(usage: MessageUsage, model?: string, at?: Date): number {
  const pricing = getModelPricing(model, usage, at);

  // Server tool charges stand whether or not the tokens could be priced.
  const webSearchCost =
    (usage.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_COST_PER_REQUEST;

  if (!pricing) {
    return round6(webSearchCost);
  }

  const { write5m, write1h } = splitCacheCreation(usage);

  const tokenCost =
    ((usage.input_tokens || 0) / 1_000_000) * pricing.input +
    ((usage.output_tokens || 0) / 1_000_000) * pricing.output +
    (write5m / 1_000_000) * pricing.cacheWrite5m +
    (write1h / 1_000_000) * pricing.cacheWrite1h +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheRead;

  const geoMultiplier = usage.inference_geo === 'us' ? US_GEO_MULTIPLIER : 1;

  return round6(tokenCost * geoMultiplier + webSearchCost);
}

/**
 * Whether a model id resolves to any price, including a family fallback. False
 * is what puts a model on the unpriced list.
 */
export function isPricedModel(model: string | undefined): boolean {
  return getModelPricing(model) !== null;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
