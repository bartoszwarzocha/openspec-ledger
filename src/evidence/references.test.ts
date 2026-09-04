import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractReferences } from './references.ts';

test('a task naming a module and a trait yields both kinds of reference', () => {
  const label =
    'Create `src/provider/mod.rs` with `LookupProvider` async trait and `resolve_provider()`';
  assert.deepEqual(extractReferences(label), {
    paths: ['src/provider/mod.rs'],
    symbols: ['LookupProvider', 'resolve_provider'],
  });
});

test('a prose-only task yields nothing', () => {
  assert.deepEqual(extractReferences('Write unit tests for the happy path'), {
    paths: [],
    symbols: [],
  });
});

test('a capitalised English word is not an identifier', () => {
  assert.deepEqual(extractReferences('Update Windows and Linux packaging'), {
    paths: [],
    symbols: [],
  });
});

test('short and numeric tokens are discarded', () => {
  const label = 'Return `ok` after `5` retries, per section `1.1`';
  assert.deepEqual(extractReferences(label), { paths: [], symbols: [] });
});

test('a bare path token is found outside an inline-code span', () => {
  const references = extractReferences('Move src/util/git.ts into src/git/, then delete it.');
  assert.deepEqual(references.paths, ['src/util/git.ts']);
  assert.deepEqual(references.symbols, []);
});

test('a backslash path is normalised to the form git reports', () => {
  assert.deepEqual(extractReferences('Patch `src\\model\\keys.ts`').paths, [
    'src/model/keys.ts',
  ]);
});

test('a leading ./ is dropped so the suffix comparison can work', () => {
  assert.deepEqual(extractReferences('Edit `./src/extension.ts`').paths, ['src/extension.ts']);
});

test('bare tokens qualify by PascalCase or by a call parenthesis', () => {
  const references = extractReferences('Have LedgerProvider call refreshTree() once.');
  assert.deepEqual(references.symbols, ['LedgerProvider', 'refreshTree']);
});

test('an acronym is not treated as an identifier', () => {
  assert.deepEqual(extractReferences('Document the API and the CLI'), { paths: [], symbols: [] });
});

test('references are deduplicated in first-seen order', () => {
  const label = 'Wire `TaskTree` to `src/a.ts`, then re-check `src/a.ts` and `TaskTree`';
  assert.deepEqual(extractReferences(label), { paths: ['src/a.ts'], symbols: ['TaskTree'] });
});

test('trailing prose punctuation does not become part of a reference', () => {
  const references = extractReferences('Add `parseTasks()`, `src/parser.ts`; done.');
  assert.deepEqual(references.paths, ['src/parser.ts']);
  assert.deepEqual(references.symbols, ['parseTasks']);
});

test('a URL is not mistaken for a repository path', () => {
  assert.deepEqual(extractReferences('See https://example.com/spec.html for details').paths, []);
});

test('an inline-code span with several words yields each of them', () => {
  const references = extractReferences('Run `npm run compile` before packaging');
  assert.deepEqual(references.symbols, ['npm', 'run', 'compile']);
});
