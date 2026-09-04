import test from 'node:test';
import assert from 'node:assert/strict';
import type { MessageUsage } from '../model/types.ts';
import {
  MODEL_PRICING,
  calculateMessageCost,
  getModelPricing,
  isPricedModel,
  normalizeModelId,
  splitCacheCreation,
} from './pricing.ts';

/** One million input tokens, so a cost equals the per-million rate exactly. */
function usage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return { input_tokens: 0, output_tokens: 0, ...overrides };
}

test('the longest matching prefix wins over the family prefix', () => {
  const dated = getModelPricing('claude-opus-4-5-20251101');
  const family = getModelPricing('claude-opus-4-20250514');

  assert.ok(dated);
  assert.ok(family);
  assert.equal(dated.input, 5);
  assert.equal(family.input, 15);
});

test('a suffixed variant resolves to its base entry', () => {
  const pricing = getModelPricing('claude-sonnet-4-5-20250929[1m]');
  assert.ok(pricing);
  assert.equal(pricing.input, 3);
});

test('provider prefixes are stripped before matching', () => {
  assert.equal(normalizeModelId('us.anthropic.claude-opus-5-v1:0'), 'claude-opus-5-v1:0');
  assert.equal(normalizeModelId('  Bedrock/Claude-Haiku-4-5  '), 'claude-haiku-4-5');

  const pricing = getModelPricing('us.anthropic.claude-opus-5-v1:0');
  assert.ok(pricing);
  assert.equal(pricing.input, 5);
});

test('an unknown model contributes zero and is reported unpriced', () => {
  const cost = calculateMessageCost(
    usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    'llama-3-70b-instruct',
  );

  assert.equal(cost, 0);
  assert.equal(isPricedModel('llama-3-70b-instruct'), false);
  assert.equal(getModelPricing('llama-3-70b-instruct'), null);
});

test('a synthetic message is not billable', () => {
  assert.equal(getModelPricing('<synthetic>'), null);
  assert.equal(isPricedModel('<synthetic>'), false);
});

test('a model id outside the table is unpriced, not guessed at from its family', () => {
  // The spec is explicit: an id matching no entry contributes zero and is
  // listed as unpriced. Pricing it at Opus rates because the name says "opus"
  // would put a number the panel cannot justify beside numbers it can.
  assert.equal(getModelPricing('claude-opus-9-20991231'), null);
  assert.equal(isPricedModel('claude-opus-9-20991231'), false);
  assert.equal(calculateMessageCost(usage({ input_tokens: 1_000_000 }), 'claude-opus-9-20991231'), 0);
});

test('one-hour cache writes are priced at twice base input', () => {
  const oneHour = calculateMessageCost(
    usage({
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    }),
    'claude-opus-5',
  );
  const fiveMinute = calculateMessageCost(
    usage({
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
    }),
    'claude-opus-5',
  );

  // claude-opus-5 costs $5 per million input: 2x for the hour, 1.25x for five minutes.
  assert.equal(oneHour, 10);
  assert.equal(fiveMinute, 6.25);
});

test('a transcript without the per-TTL split treats the total as a five-minute write', () => {
  assert.deepEqual(splitCacheCreation(usage({ cache_creation_input_tokens: 900 })), {
    write5m: 900,
    write1h: 0,
  });
  assert.deepEqual(
    splitCacheCreation(
      usage({
        cache_creation_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      }),
    ),
    { write5m: 900, write1h: 0 },
  );
});

test('cache reads are priced at a tenth of base input', () => {
  const cost = calculateMessageCost(
    usage({ cache_read_input_tokens: 1_000_000 }),
    'claude-opus-5',
  );
  assert.equal(cost, 0.5);
});

test('fast mode reprices Opus 5', () => {
  const standard = calculateMessageCost(usage({ input_tokens: 1_000_000 }), 'claude-opus-5');
  const fast = calculateMessageCost(
    usage({ input_tokens: 1_000_000, speed: 'fast' }),
    'claude-opus-5',
  );

  assert.equal(standard, 5);
  assert.equal(fast, 10);
});

test('fast mode leaves a model it does not apply to alone', () => {
  const cost = calculateMessageCost(
    usage({ input_tokens: 1_000_000, speed: 'fast' }),
    'claude-sonnet-4-5',
  );
  assert.equal(cost, 3);
});

test('the Sonnet 5 introductory window depends on when the message was sent', () => {
  const during = calculateMessageCost(
    usage({ input_tokens: 1_000_000 }),
    'claude-sonnet-5',
    new Date('2026-08-15T12:00:00Z'),
  );
  const after = calculateMessageCost(
    usage({ input_tokens: 1_000_000 }),
    'claude-sonnet-5',
    new Date('2026-09-15T12:00:00Z'),
  );

  assert.equal(during, 2);
  assert.equal(after, 3);
});

test('US-only inference applies the 1.1x multiplier', () => {
  const cost = calculateMessageCost(
    usage({ input_tokens: 1_000_000, inference_geo: 'us' }),
    'claude-opus-5',
  );
  assert.equal(cost, 5.5);
});

test('web search is charged even when the tokens cannot be priced', () => {
  const cost = calculateMessageCost(
    usage({
      input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 3 },
    }),
    'some-unknown-model',
  );
  assert.equal(cost, 0.03);
});

test('a message with no model id contributes nothing rather than a guessed tier', () => {
  assert.equal(calculateMessageCost(usage({ input_tokens: 1_000_000 })), 0);
});

test('server tool charges stand even when the tokens cannot be priced', () => {
  const cost = calculateMessageCost(
    usage({ input_tokens: 1_000_000, server_tool_use: { web_search_requests: 100 } }),
    'claude-opus-9-20991231',
  );
  assert.equal(cost, 1);
});

test('the vendored table keeps the documented cache multipliers', () => {
  const opus = MODEL_PRICING['claude-opus-5'];
  assert.ok(opus);
  assert.equal(opus.cacheWrite5m, opus.input * 1.25);
  assert.equal(opus.cacheWrite1h, opus.input * 2);
  assert.equal(opus.cacheRead, opus.input * 0.1);
});
