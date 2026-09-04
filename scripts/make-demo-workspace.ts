/**
 * Builds a workspace to take screenshots against.
 *
 * The extension is only interesting when it has something to say - a change
 * that stalled in May, one task short of done, a curve with a flat stretch in
 * it - and none of that can be faked in a static fixture, because the stall
 * figures and the progress curve are read out of real commit dates. So this
 * generates real git repositories and commits their `tasks.md` over months,
 * with `GIT_AUTHOR_DATE` set, and lets the extension derive everything else.
 *
 * Nothing here comes from anybody's real project. The product is invented, the
 * dates are fixed, and running it twice produces the same workspace, so a
 * screenshot can be retaken later and still match.
 *
 *   node scripts/make-demo-workspace.ts [target] [--force]
 *
 * The default target is a sibling of this repository. `--force` replaces an
 * existing one; without it, an existing directory is left alone.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The invented product
// ---------------------------------------------------------------------------

interface TaskSpec {
  /** Task text, without the `N.M` prefix, which is added from the position. */
  text: string;
  /** Which revision ticks it. 0 means it was already complete at the first. */
  doneAt?: number;
  /** Marked in progress rather than complete or pending. */
  started?: boolean;
}

interface SectionSpec {
  title: string;
  tasks: TaskSpec[];
}

interface ChangeSpec {
  id: string;
  summary: string;
  created: string;
  /** Author dates of the commits that touch `tasks.md`, oldest first. */
  revisions: string[];
  sections?: SectionSpec[];
  /** No `tasks.md` at all: a proposal nobody decomposed. */
  undecomposed?: boolean;
  /** A `tasks.md` that exists but holds no task lines yet. */
  emptyTasks?: boolean;
  design?: boolean;
  /** Source files the commits also touch, so git evidence has something real. */
  sources?: string[];
}

interface RepoSpec {
  /** Path relative to the workspace root; the nesting is the point. */
  dir: string;
  title: string;
  purpose: string;
  changes: ChangeSpec[];
}

/** Ticked from the first revision onwards. */
const done = (text: string): TaskSpec => ({ text, doneAt: 0 });

const SEGMENT_STEPS = [
  'claim the segment and record the lease',
  'stream the source rows for the range',
  'build the shadow segment',
  'compare document counts against the live segment',
  'swap and release the lease',
  'delete the shadow on success',
  'retry the segment on a transient failure',
];

const CURSOR_STEPS = [
  'persist the position after each batch',
  'resume from the last persisted position',
  'detect a mapping change and restart the segment',
  'expose the position for monitoring',
  'test a crash between batches',
  'test a crash mid-batch',
];

const VERIFY_STEPS = [
  'document counts match the source',
  'a sampled document is byte-identical',
  'query latency is unchanged at p50',
  'query latency is unchanged at p99',
  'the swap is invisible to a running query',
  'a failed segment leaves the live index untouched',
  'the lease expires when a worker dies',
];

const REPOS: RepoSpec[] = [
  {
    dir: 'api-gateway',
    title: 'API Gateway',
    purpose: 'Edge routing, authentication and rate limiting for every public request.',
    changes: [
      {
        id: 'rate-limit-per-tenant',
        summary:
          'One tenant exhausting the shared bucket takes the gateway down for everybody. ' +
          'Rate limiting moves from a global counter to a per-tenant one.',
        created: '2026-04-08',
        revisions: ['2026-04-09', '2026-04-14', '2026-04-22'],
        design: true,
        sources: ['src/limiter/bucket.ts', 'src/limiter/tenant.ts', 'src/middleware/limit.ts'],
        sections: [
          {
            title: '1. Bucket',
            tasks: [
              { text: 'Add `TenantBucket` to `src/limiter/bucket.ts`, keyed by tenant id', doneAt: 0 },
              { text: 'Move the refill clock behind `Clock` so the tests can advance it', doneAt: 0 },
              { text: 'Unit tests: refill, burst, exhaustion, and a tenant with no quota', doneAt: 1 },
            ],
          },
          {
            title: '2. Middleware',
            tasks: [
              { text: 'Resolve the tenant from the signed token in `src/middleware/limit.ts`', doneAt: 1 },
              { text: 'Return 429 with `Retry-After` rather than dropping the connection', doneAt: 1 },
              { text: 'Fall back to the global bucket when the tenant cannot be resolved', doneAt: 2 },
            ],
          },
          {
            title: '3. Rollout',
            tasks: [
              { text: 'Shadow mode: count without rejecting, for one week', doneAt: 2 },
              { text: 'Compare shadow counts against the global bucket and record the delta', doneAt: 2 },
              { text: 'Enable enforcement per tenant, starting with the two largest', doneAt: 2 },
            ],
          },
        ],
      },
      {
        id: '2026-08-30-request-id-propagation',
        summary:
          'A request id is generated at the edge and then lost at the first hop, so a trace ' +
          'through three services cannot be reassembled.',
        created: '2026-08-30',
        revisions: ['2026-08-30', '2026-09-01'],
        sources: ['src/tracing/context.ts', 'src/client/forward.ts'],
        sections: [
          {
            title: '1. Generate and carry',
            tasks: [
              { text: 'Generate `x-request-id` at the edge when the caller did not send one', doneAt: 0 },
              { text: 'Store it in `RequestContext` in `src/tracing/context.ts`', doneAt: 0 },
              { text: 'Forward it on every outbound call from `src/client/forward.ts`', doneAt: 1 },
            ],
          },
          {
            title: '2. Log and verify',
            tasks: [
              { text: 'Add the id to every structured log line', doneAt: 1 },
              { text: 'Integration test: one request, three services, one id in all nine lines' },
              { text: 'Document the header in the public API reference' },
            ],
          },
        ],
      },
      {
        id: 'mtls-between-services',
        summary:
          'Internal traffic is plaintext inside the cluster. Mutual TLS between services, ' +
          'with certificates issued by the platform CA.',
        created: '2026-07-20',
        revisions: ['2026-07-21', '2026-07-31'],
        design: true,
        sources: ['src/transport/tls.ts', 'deploy/certificates.yaml'],
        sections: [
          {
            title: '1. Certificates',
            tasks: [
              { text: 'Issue a service certificate from the platform CA', doneAt: 0 },
              { text: 'Mount it through `deploy/certificates.yaml` with a 30-day rotation', doneAt: 0 },
              { text: 'Rotation drill: expire one certificate deliberately and watch recovery', doneAt: 1 },
            ],
          },
          {
            title: '2. Transport',
            tasks: [
              { text: 'Require and verify the peer certificate in `src/transport/tls.ts`', doneAt: 1 },
              { text: 'Pin the accepted issuer rather than the leaf', doneAt: 1 },
              { text: 'Allow plaintext for the health endpoint only', started: true },
              { text: 'Load test with TLS on and compare the p99 against the plaintext baseline' },
              { text: 'Turn plaintext off in staging for a week before production' },
              { text: 'Runbook: what to do when a certificate expires at 03:00' },
            ],
          },
        ],
      },
    ],
  },
  {
    dir: 'services/catalog-service',
    title: 'Catalog Service',
    purpose: 'Products, variants and categories, and the read model the storefront queries.',
    changes: [
      {
        id: 'add-variant-pricing',
        summary:
          'A product carries one price today. Variants need their own, with the product price ' +
          'as the fallback.',
        created: '2026-03-02',
        revisions: ['2026-03-03', '2026-03-09', '2026-03-18', '2026-03-27'],
        design: true,
        sources: ['src/pricing/resolver.rs', 'src/model/variant.rs', 'src/api/price.rs'],
        sections: [
          {
            title: '1. Model',
            tasks: [
              { text: 'Add `price` to `Variant` in `src/model/variant.rs`, nullable', doneAt: 0 },
              { text: 'Migration, with the existing product price copied down where it differs', doneAt: 0 },
              { text: 'Backfill script for the 40k rows already in production', doneAt: 1 },
            ],
          },
          {
            title: '2. Resolution',
            tasks: [
              { text: 'Write `resolve_price()` in `src/pricing/resolver.rs`: variant, then product', doneAt: 1 },
              { text: 'Currency must match; a mismatch is an error, not a silent fallback', doneAt: 1 },
              { text: 'Unit tests: variant set, variant null, currency mismatch, no product', doneAt: 2 },
            ],
          },
          {
            title: '3. API',
            tasks: [
              { text: 'Expose the resolved price in `src/api/price.rs`', doneAt: 2 },
              { text: 'Keep the old field populated for one release', doneAt: 2 },
              { text: 'Contract test against the storefront client', doneAt: 3 },
            ],
          },
          {
            title: '4. Verification',
            tasks: [
              { text: 'Compare resolved prices against the old table for every product', doneAt: 3 },
              { text: 'Load test the read path: no regression beyond 5 percent', doneAt: 3 },
            ],
          },
        ],
      },
      {
        id: '2026-07-02-bulk-import-endpoint',
        summary:
          'Merchants import catalogues by hand, one product at a time. A bulk endpoint that ' +
          'accepts a file and reports per-row failures.',
        created: '2026-07-02',
        revisions: ['2026-07-03', '2026-07-06', '2026-07-08'],
        sources: ['src/api/import.rs', 'src/import/parser.rs', 'src/import/report.rs'],
        sections: [
          {
            title: '1. Parsing',
            tasks: [
              { text: 'Accept CSV and JSON Lines in `src/import/parser.rs`', doneAt: 0 },
              { text: 'Stream rather than buffer: a 200 MB file must not be held in memory', doneAt: 0 },
              { text: 'Reject a file whose header does not match the documented columns', doneAt: 0 },
              { text: 'Tests: both formats, a truncated file, a row with too few columns', doneAt: 1 },
            ],
          },
          {
            title: '2. Validation and report',
            tasks: [
              { text: 'Validate each row independently; one bad row does not fail the file', doneAt: 1 },
              { text: 'Collect failures into `ImportReport` in `src/import/report.rs`', doneAt: 1 },
              { text: 'Report the row number and the column that failed, not just a message', doneAt: 1 },
              { text: 'Cap the report at 1000 entries and say how many were dropped', doneAt: 2 },
              { text: 'Tests: all valid, all invalid, mixed, and the cap', doneAt: 2 },
            ],
          },
          {
            title: '3. Endpoint',
            tasks: [
              { text: 'POST /catalog/import in `src/api/import.rs`, returning 202 and a job id', doneAt: 2 },
              { text: 'GET the job to poll status and fetch the report', doneAt: 2 },
              { text: 'Authorise against the merchant that owns the catalogue', doneAt: 2 },
              { text: 'Rate limit: one import per merchant at a time', doneAt: 2 },
              { text: 'Integration test through the gateway', doneAt: 2 },
            ],
          },
          {
            title: '4. Operability',
            tasks: [
              { text: 'Metrics: rows accepted, rows rejected, duration per file', doneAt: 2 },
              { text: 'Alert when the rejection rate for a merchant exceeds 20 percent', doneAt: 2 },
              { text: 'Runbook for a stuck import job', doneAt: 2 },
              { text: 'Document the CSV columns in the merchant handbook' },
            ],
          },
        ],
      },
      {
        id: 'normalise-category-tree',
        summary:
          'Categories are a free-form string on the product. They become a tree with stable ' +
          'ids, so a rename stops orphaning products.',
        created: '2026-08-19',
        revisions: ['2026-08-20', '2026-08-27', '2026-09-02'],
        design: true,
        sources: ['src/model/category.rs', 'src/migration/categories.rs'],
        sections: [
          {
            title: '1. Model',
            tasks: [
              { text: 'Add `Category` with a stable id and a parent in `src/model/category.rs`', doneAt: 0 },
              { text: 'Products reference the id rather than the label', doneAt: 0 },
              { text: 'Reject a cycle when a parent is assigned', doneAt: 1 },
              { text: 'Tests: depth, cycle, orphan, and a category with 5000 products', doneAt: 1 },
            ],
          },
          {
            title: '2. Migration',
            tasks: [
              { text: 'Derive the tree from the distinct strings in production', doneAt: 1 },
              { text: 'Report the strings that could not be placed, rather than guessing', doneAt: 2 },
              { text: 'Dry run against a production snapshot', doneAt: 2 },
              { text: 'Write `src/migration/categories.rs` with a reversible step', started: true },
              { text: 'Rehearse the rollback on the snapshot' },
            ],
          },
          {
            title: '3. Read model',
            tasks: [
              { text: 'Rebuild the storefront read model from the tree' },
              { text: 'Breadcrumbs from the ancestors, cached per category' },
              { text: 'Compare storefront results before and after for the top 200 queries' },
            ],
          },
          {
            title: '4. Cutover',
            tasks: [
              { text: 'Dual-write for one release' },
              { text: 'Switch reads, keeping the string column populated' },
              { text: 'Drop the string column a release later' },
            ],
          },
        ],
      },
      {
        id: '2026-08-28-price-rounding-rules',
        summary:
          'Rounding happens in three places with three different rules, and the invoice total ' +
          'disagrees with the sum of its lines by a cent.',
        created: '2026-08-28',
        revisions: ['2026-08-29', '2026-09-03'],
        sources: ['src/pricing/rounding.rs'],
        sections: [
          {
            title: '1. One rule',
            tasks: [
              { text: 'Write `round_money()` in `src/pricing/rounding.rs`, banker\'s rounding', doneAt: 0 },
              { text: 'Property test: summing rounded lines equals the rounded sum, or says why', doneAt: 0 },
              { text: 'Replace the three call sites', doneAt: 1 },
            ],
          },
          {
            title: '2. Verification',
            tasks: [
              { text: 'Recompute a month of invoices and diff against what was billed', doneAt: 1 },
              { text: 'Report every invoice that moves, however little', doneAt: 1 },
              { text: 'Sign-off from finance before the change ships' },
              { text: 'Note the rule in the merchant handbook' },
            ],
          },
        ],
      },
      {
        id: 'deprecate-legacy-sku-lookup',
        summary:
          'The v1 SKU lookup has two callers left and a cache that nobody understands. This ' +
          'proposal is the case for removing it rather than fixing it.',
        created: '2026-06-11',
        revisions: ['2026-06-11'],
        undecomposed: true,
      },
    ],
  },
  {
    dir: 'services/billing-service',
    title: 'Billing Service',
    purpose: 'Invoices, payments, dunning and the ledger the finance team reconciles against.',
    changes: [
      {
        id: 'invoice-pdf-rendering',
        summary:
          'Invoices are HTML emails. Customers want a PDF that looks the same in ten years, ' +
          'with the tax breakdown their accountant expects.',
        created: '2026-02-10',
        revisions: ['2026-02-11', '2026-02-17', '2026-02-25', '2026-03-04'],
        design: true,
        sources: ['src/render/pdf.py', 'src/render/template.py', 'src/api/invoice.py'],
        sections: [
          {
            title: '1. Template',
            tasks: [
              { text: 'Lay out the invoice in `src/render/template.py`, one page per 20 lines', doneAt: 0 },
              { text: 'Tax breakdown as its own block, with the rate beside each amount', doneAt: 0 },
              { text: 'Company details from configuration, not hard coded', doneAt: 0 },
              { text: 'Golden-file tests for three locales', doneAt: 1 },
            ],
          },
          {
            title: '2. Rendering',
            tasks: [
              { text: 'Render through `render_invoice()` in `src/render/pdf.py`', doneAt: 1 },
              { text: 'Embed the fonts so the file does not depend on the reader', doneAt: 1 },
              { text: 'PDF/A-3 so it survives archiving', doneAt: 2 },
              { text: 'Reject a render that exceeds 2 MB rather than emailing it', doneAt: 2 },
            ],
          },
          {
            title: '3. Delivery',
            tasks: [
              { text: 'Attach the PDF in `src/api/invoice.py` and keep the HTML body', doneAt: 2 },
              { text: 'Store the rendered file, keyed by invoice id and version', doneAt: 2 },
              { text: 'Re-render on demand rather than on every read', doneAt: 3 },
            ],
          },
          {
            title: '4. Verification',
            tasks: [
              { text: 'Render every invoice from the last quarter and check the totals', doneAt: 3 },
              { text: 'Open a sample in four readers, including one from 2019', doneAt: 3 },
              { text: 'Finance sign-off on the tax block', doneAt: 3 },
            ],
          },
        ],
      },
      {
        id: '2026-05-14-dunning-retry-schedule',
        summary:
          'A failed payment is retried every hour until the card issuer blocks us. The retry ' +
          'schedule becomes a documented curve with a cap.',
        created: '2026-05-14',
        revisions: ['2026-05-15', '2026-05-18'],
        sources: ['src/dunning/schedule.py', 'src/dunning/worker.py'],
        sections: [
          {
            title: '1. Schedule',
            tasks: [
              { text: 'Define the curve in `src/dunning/schedule.py`: 1h, 6h, 24h, 72h, stop', doneAt: 0 },
              { text: 'Never retry a hard decline; the issuer has already answered', doneAt: 0 },
              { text: 'Tests: soft decline, hard decline, expiry mid-schedule', doneAt: 1 },
            ],
          },
          {
            title: '2. Worker',
            tasks: [
              { text: 'Read the schedule in `src/dunning/worker.py` instead of the fixed hour', doneAt: 1 },
              { text: 'Record every attempt with its outcome for the audit trail', doneAt: 1 },
              { text: 'Stop and notify when the schedule is exhausted', doneAt: 1 },
              { text: 'Backfill the audit trail for the retries already made', doneAt: 1 },
              { text: 'Dashboard: attempts, recoveries and exhaustions per day', doneAt: 1 },
              { text: 'Rehearse the notification email with support', doneAt: 1 },
              { text: 'Compare the recovery rate against the fixed-hour baseline', doneAt: 1 },
              { text: 'Remove the fixed-hour path once the comparison is in' },
            ],
          },
        ],
      },
      {
        id: 'split-tax-calculation',
        summary:
          'Tax is computed inside the invoice builder, so a quote and an invoice for the same ' +
          'basket can disagree. It moves out into its own module.',
        created: '2026-08-25',
        revisions: ['2026-08-26', '2026-09-01'],
        sources: ['src/tax/engine.py', 'src/invoice/builder.py'],
        sections: [
          {
            title: '1. Extract',
            tasks: [
              { text: 'Move the rules into `src/tax/engine.py` behind `calculate_tax()`', doneAt: 0 },
              { text: 'The engine takes a basket and a jurisdiction, and nothing else', doneAt: 0 },
              { text: 'Characterisation tests captured from the current behaviour', doneAt: 1 },
              { text: 'Call it from `src/invoice/builder.py`' },
              { text: 'Call it from the quote path', started: true },
            ],
          },
          {
            title: '2. Rules',
            tasks: [
              { text: 'Reverse charge for cross-border business customers' },
              { text: 'Reduced rates by product class' },
              { text: 'Rounding per line, per the finance note' },
              { text: 'Tests per jurisdiction, from the finance spreadsheet' },
            ],
          },
          {
            title: '3. Verification',
            tasks: [
              { text: 'Recompute a quarter of invoices and diff' },
              { text: 'Quote and invoice agree for 10,000 sampled baskets' },
              { text: 'Finance sign-off' },
            ],
          },
        ],
      },
      {
        id: 'refund-audit-trail',
        summary:
          'Refunds are recorded as a negative payment with no reason and no actor. The audit ' +
          'trail needs both, and finance needs to query it.',
        created: '2026-09-01',
        revisions: ['2026-09-01'],
        emptyTasks: true,
      },
    ],
  },
  {
    dir: 'services/search-indexer',
    title: 'Search Indexer',
    purpose: 'Builds and maintains the search index from the catalogue event stream.',
    changes: [
      {
        id: 'incremental-reindex',
        summary:
          'A full reindex takes eleven hours and is the only way to pick up a mapping change. ' +
          'Incremental reindexing, segment by segment, with a resumable cursor.',
        created: '2026-08-24',
        revisions: ['2026-08-25', '2026-09-03'],
        design: true,
        sources: ['src/index/segment.go', 'src/index/cursor.go'],
        sections: [
          {
            title: '1. Segments',
            tasks: [
              { text: 'Partition the corpus into segments in `src/index/segment.go`', doneAt: 0 },
              { text: 'A segment is reindexed independently and swapped atomically', doneAt: 1 },
              ...Array.from({ length: 34 }, (_, i) => ({
                text: `Segment worker step ${i + 1}: ${SEGMENT_STEPS[i % SEGMENT_STEPS.length]}`,
              })),
            ],
          },
          {
            title: '2. Cursor',
            tasks: Array.from({ length: 38 }, (_, i) => ({
              text: `Cursor ${i + 1}: ${CURSOR_STEPS[i % CURSOR_STEPS.length]}`,
            })),
          },
          {
            title: '3. Verification',
            tasks: Array.from({ length: 71 }, (_, i) => ({
              text: `Check ${i + 1}: ${VERIFY_STEPS[i % VERIFY_STEPS.length]}`,
            })),
          },
        ],
      },
      {
        id: '2026-06-20-synonym-dictionary',
        summary:
          'Searches for "trainers" return nothing because the catalogue says "sneakers". A ' +
          'curated synonym set, versioned with the index.',
        created: '2026-06-20',
        revisions: ['2026-06-21', '2026-06-25', '2026-06-28'],
        sources: ['src/analysis/synonyms.go', 'data/synonyms.txt'],
        sections: [
          {
            title: '1. Loading',
            tasks: [
              { text: 'Read `data/synonyms.txt` at index build time', doneAt: 0 },
              { text: 'Version the set with the index so a rollback is coherent', doneAt: 0 },
              { text: 'Reject a malformed line loudly rather than skipping it', doneAt: 1 },
              { text: 'Tests: symmetric, one-way, and a cycle', doneAt: 1 },
            ],
          },
          {
            title: '2. Analysis',
            tasks: [
              { text: 'Apply the set in `src/analysis/synonyms.go` at query time', doneAt: 1 },
              { text: 'Expansion must not blow the clause limit', doneAt: 2 },
              { text: 'Measure the latency cost of expansion at p50 and p99', doneAt: 2 },
            ],
          },
          {
            title: '3. Curation',
            tasks: [
              { text: 'Seed from the top 500 zero-result queries', doneAt: 2 },
              { text: 'Review with merchandising', doneAt: 2 },
              { text: 'Weekly report of new zero-result queries', doneAt: 2 },
              { text: 'Document how a merchant requests an addition' },
            ],
          },
        ],
      },
      {
        id: 'drop-legacy-analyzer',
        summary:
          'The pre-2024 analyzer is still built into every index and used by nothing. The case ' +
          'for removing it, and what has to be proved first.',
        created: '2026-05-30',
        revisions: ['2026-05-30'],
        undecomposed: true,
      },
    ],
  },
  {
    dir: 'web/console-ui',
    title: 'Console UI',
    purpose: 'The operator console: catalogue, orders, invoices and the audit log.',
    changes: [
      {
        id: 'theme-tokens',
        summary:
          'Colours are hard coded in 140 components. They move into tokens so a dark theme is ' +
          'a change of values rather than a change of components.',
        created: '2026-04-02',
        revisions: ['2026-04-03', '2026-04-11', '2026-04-19'],
        design: true,
        sources: ['src/styles/tokens.css', 'src/styles/theme.ts'],
        sections: [
          {
            title: '1. Tokens',
            tasks: [
              { text: 'Define the palette in `src/styles/tokens.css` as custom properties', doneAt: 0 },
              { text: 'Semantic names, not colour names: surface, border, danger', doneAt: 0 },
              { text: 'Contrast check every pair against WCAG AA', doneAt: 1 },
            ],
          },
          {
            title: '2. Migration',
            tasks: [
              { text: 'Codemod the 140 components to the tokens', doneAt: 1 },
              { text: 'Fail the build on a literal colour outside `tokens.css`', doneAt: 1 },
              { text: 'Visual diff of every screen before and after', doneAt: 2 },
            ],
          },
          {
            title: '3. Dark theme',
            tasks: [
              { text: 'Second value set in `src/styles/theme.ts`', doneAt: 2 },
              { text: 'Follow the operating system by default, with an override', doneAt: 2 },
              { text: 'Contrast check the dark set too', doneAt: 2 },
            ],
          },
        ],
      },
      {
        id: '2026-08-11-bulk-actions-toolbar',
        summary:
          'Operators cancel orders one at a time. A selection model and a toolbar that acts on ' +
          'the selection, with a confirmation that names what it will touch.',
        created: '2026-08-11',
        revisions: ['2026-08-12', '2026-08-18', '2026-09-02'],
        sources: ['src/components/Toolbar.tsx', 'src/state/selection.ts'],
        sections: [
          {
            title: '1. Selection',
            tasks: [
              { text: 'Selection state in `src/state/selection.ts`, survives pagination', doneAt: 0 },
              { text: 'Select all across pages, with the count shown', doneAt: 0 },
              { text: 'Clear on filter change, because the rows are no longer the same rows', doneAt: 1 },
              { text: 'Tests: page, cross-page, filter change, empty result', doneAt: 1 },
            ],
          },
          {
            title: '2. Toolbar',
            tasks: [
              { text: 'Render actions in `src/components/Toolbar.tsx` for the current selection', doneAt: 1 },
              { text: 'Disable an action the operator cannot perform on every selected row', doneAt: 1 },
              { text: 'Confirmation names the count and lists the first ten', doneAt: 2 },
              { text: 'Progress and per-row failures, rather than one success toast', doneAt: 2 },
            ],
          },
          {
            title: '3. Actions',
            tasks: [
              { text: 'Cancel orders', doneAt: 2 },
              { text: 'Export selection to CSV', doneAt: 2 },
              { text: 'Assign to an operator', doneAt: 2 },
              { text: 'Add a note to every selected order', doneAt: 2 },
            ],
          },
          {
            title: '4. Verification',
            tasks: [
              { text: 'Keyboard path for every action', doneAt: 2 },
              { text: 'Screen reader announces the selection count on change', doneAt: 2 },
              { text: 'Cancel 500 orders in one action against staging', doneAt: 2 },
              { text: 'Operator walkthrough with two people from support', doneAt: 2 },
              { text: 'Record the failure-handling behaviour in the operator handbook' },
            ],
          },
        ],
      },
      {
        id: 'keyboard-navigation-audit',
        summary:
          'Half the console cannot be operated without a mouse. An audit of every screen, and ' +
          'the fixes that follow from it.',
        created: '2026-07-14',
        revisions: ['2026-07-15', '2026-07-26'],
        sources: ['src/components/Table.tsx', 'src/hooks/useFocusTrap.ts'],
        sections: [
          {
            title: '1. Audit',
            tasks: [
              { text: 'Walk every screen with the mouse unplugged and write down what fails', doneAt: 0 },
              { text: 'Group the failures: focus order, trap, invisible focus, no shortcut', doneAt: 0 },
              { text: 'Rank by how often the screen is used', doneAt: 1 },
            ],
          },
          {
            title: '2. Fixes',
            tasks: [
              { text: 'Focus trap for dialogs in `src/hooks/useFocusTrap.ts`', doneAt: 1 },
              { text: 'Roving tabindex in `src/components/Table.tsx`', doneAt: 1 },
              { text: 'Visible focus ring that survives the theme change', doneAt: 1 },
              { text: 'Skip link to the main region' },
              { text: 'Shortcut for the command palette' },
              { text: 'Escape closes the topmost layer only' },
            ],
          },
          {
            title: '3. Keeping it',
            tasks: [
              { text: 'Automated check for focus order on the ten busiest screens' },
              { text: 'Add the check to the pull request pipeline' },
              { text: 'Write the rule down so a new component starts compliant' },
            ],
          },
        ],
      },
      {
        id: 'empty-state-illustrations',
        summary:
          'Every empty list says "No results". The proposal is a set of empty states that say ' +
          'what happened and what to do next.',
        created: '2026-08-05',
        revisions: ['2026-08-05'],
        undecomposed: true,
      },
    ],
  },
  {
    dir: 'docs',
    title: 'Documentation',
    purpose: 'Handbooks, runbooks and the public API reference.',
    changes: [
      {
        id: 'contributor-onboarding',
        summary:
          'A new contributor takes two days to get a local environment running, mostly by ' +
          'asking. The path becomes one page and one script.',
        created: '2026-06-02',
        revisions: ['2026-06-03', '2026-06-10'],
        sources: ['docs/onboarding.md', 'scripts/bootstrap.sh'],
        sections: [
          {
            title: '1. The page',
            tasks: [
              { text: 'One page in `docs/onboarding.md`, ordered by what blocks what', doneAt: 0 },
              { text: 'Every step states what success looks like', doneAt: 0 },
              { text: 'Name the person to ask when a step fails', doneAt: 1 },
            ],
          },
          {
            title: '2. The script',
            tasks: [
              { text: '`scripts/bootstrap.sh` does everything the page describes', doneAt: 1 },
              { text: 'Idempotent: running it twice is safe', doneAt: 1 },
              { text: 'Tested on a clean machine by someone who has not seen the repository', doneAt: 1 },
            ],
          },
        ],
      },
    ],
  },
];


// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = path.resolve(HERE, '..', '..', 'openspec-ledger-demo');

const target = process.argv[2] && !process.argv[2].startsWith('--')
  ? path.resolve(process.argv[2])
  : DEFAULT_TARGET;
const force = process.argv.includes('--force');

function git(args: readonly string[], cwd: string, at?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stamp = at ? `${at}T10:24:00` : undefined;
    const child = spawn('git', [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      env: stamp
        ? { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
        : process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed: ${err.trim()}`));
    });
  });
}

/** The task list as it stood at `revision`, which is what makes the curve real. */
function tasksMarkdown(change: ChangeSpec, revision: number): string {
  const lines = [`# Tasks — ${change.id}`, ''];
  change.sections?.forEach((section, sectionIndex) => {
    lines.push(`## ${sectionIndex + 1}. ${section.title.replace(/^\d+\.\s*/, '')}`, '');
    section.tasks.forEach((task, taskIndex) => {
      const complete = task.doneAt !== undefined && task.doneAt <= revision;
      const marker = complete ? 'x' : task.started ? '-' : ' ';
      lines.push(`- [${marker}] ${sectionIndex + 1}.${taskIndex + 1} ${task.text}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}

function proposalMarkdown(change: ChangeSpec): string {
  return [
    '## Why',
    '',
    change.summary,
    '',
    '## What Changes',
    '',
    ...(change.sections ?? []).map((section) => `- ${section.title.replace(/^\d+\.\s*/, '')}`),
    '',
    '## Impact',
    '',
    'Behaviour changes for existing callers are listed in the tasks; nothing is removed without a',
    'release of overlap.',
    '',
  ].join('\n');
}

function designMarkdown(change: ChangeSpec): string {
  return [
    `# Design — ${change.id}`,
    '',
    '## Context',
    '',
    change.summary,
    '',
    '## Decisions',
    '',
    '### D1. Keep the change reversible for one release',
    '',
    'The old path stays populated while the new one is proved, so a rollback is a configuration',
    'change rather than a migration.',
    '',
    '### D2. Verify against production data before switching',
    '',
    'Every step that changes a stored value is rehearsed against a snapshot first, and the',
    'comparison is recorded rather than eyeballed.',
    '',
  ].join('\n');
}

async function writeChange(root: string, change: ChangeSpec, revision: number): Promise<void> {
  const dir = path.join(root, 'openspec', 'changes', change.id);
  await fs.mkdir(path.join(dir, 'specs', 'behaviour'), { recursive: true });

  await fs.writeFile(
    path.join(dir, '.openspec.yaml'),
    `schema: spec-driven\ncreated: ${change.created}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'proposal.md'), proposalMarkdown(change), 'utf8');
  if (change.design) {
    await fs.writeFile(path.join(dir, 'design.md'), designMarkdown(change), 'utf8');
  }
  await fs.writeFile(
    path.join(dir, 'specs', 'behaviour', 'spec.md'),
    [
      `# Spec: ${change.id}`,
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Observable from outside',
      '',
      'The system SHALL make the behaviour described in the proposal observable through its public',
      'interface, so that it can be verified without reading the implementation.',
      '',
      '#### Scenario: The documented case',
      '- **WHEN** the interface is exercised as the proposal describes',
      '- **THEN** the result SHALL match what the proposal states',
      '',
    ].join('\n'),
    'utf8',
  );

  if (change.undecomposed) {
    return;
  }
  await fs.writeFile(
    path.join(dir, 'tasks.md'),
    change.emptyTasks
      ? `# Tasks — ${change.id}\n\nNot broken down yet.\n`
      : tasksMarkdown(change, revision),
    'utf8',
  );
}

async function buildRepo(root: string, repo: RepoSpec): Promise<void> {
  await fs.mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
  await fs.writeFile(path.join(root, 'openspec', 'specs', '.gitkeep'), '', 'utf8');
  await fs.writeFile(
    path.join(root, 'openspec', 'config.yaml'),
    [
      'schema: spec-driven',
      '',
      'context: |',
      `  ## ${repo.title}`,
      '',
      `  ${repo.purpose}`,
      '',
      '  A demonstration workspace. Nothing here describes a real product.',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'openspec', 'project.md'),
    `# ${repo.title}\n\n${repo.purpose}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'README.md'),
    `# ${repo.title}\n\n${repo.purpose}\n`,
    'utf8',
  );

  await git(['init', '-q', '-b', 'main'], root);
  for (const [key, value] of [
    ['user.name', 'Demo Author'],
    ['user.email', 'demo@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ]) {
    await git(['config', key ?? '', value ?? ''], root);
  }

  // Revision 0 for every change, then one commit per further revision. Each
  // commit also touches the source files the tasks name, so the git evidence
  // layer has something real to corroborate against.
  const dates = [...new Set(REPO_DATES(repo))].sort();
  for (const [index, date] of dates.entries()) {
    for (const change of repo.changes) {
      const revision = change.revisions.filter((r) => r <= date).length - 1;
      if (revision < 0) {
        continue;
      }
      await writeChange(root, change, revision);
      for (const source of change.sources ?? []) {
        const file = path.join(root, source);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, `// ${change.id}: revision ${revision}\n`, 'utf8');
      }
    }
    await git(['add', '-A'], root);
    await git(['commit', '-q', '-m', index === 0 ? 'Initial import' : `Progress on ${date}`], root, date);
  }
}

function REPO_DATES(repo: RepoSpec): string[] {
  return repo.changes.flatMap((change) => change.revisions);
}

async function main(): Promise<void> {
  const exists = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
  if (exists && !force) {
    console.error(`${target} already exists. Pass --force to replace it.`);
    process.exit(1);
  }
  if (exists) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log(`Building the demo workspace in ${target}`);
  for (const repo of REPOS) {
    const root = path.join(target, repo.dir);
    await fs.mkdir(root, { recursive: true });
    await buildRepo(root, repo);
    const decomposed = repo.changes.filter((c) => !c.undecomposed);
    console.log(`  ${repo.dir.padEnd(28)} ${repo.changes.length} changes, ${decomposed.length} decomposed`);
  }

  // A directory with no `openspec/` at all, so discovery has something to skip.
  await fs.mkdir(path.join(target, 'tools', 'scratch'), { recursive: true });
  await fs.writeFile(path.join(target, 'tools', 'scratch', 'notes.md'), '# Scratch\n', 'utf8');

  console.log(
    `\nDone. Open ${target} in VS Code.\n` +
      'Everything in it is invented; the commit dates are what make the stall figures and the\n' +
      'progress curve real, so the screenshots show the extension working rather than a mock.',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
