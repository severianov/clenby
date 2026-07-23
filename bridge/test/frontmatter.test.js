/**
 * readFrontmatterField + HandoffStore meta precedence. The extension
 * JSON-quotes every frontmatter string it writes; the reader must decode the
 * same way — `#` and quotes inside titles used to truncate/mangle (review B3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFrontmatterField, HandoffStore } from '../src/handoffs.js';

test('JSON-quoted values survive # and escaped quotes intact', () => {
  const md = '---\nschema: "clenby.handoff/1"\nsource_title: "Fix #42 \\"quoted\\" title"\n---\nbody';
  assert.equal(readFrontmatterField(md, 'source_title'), 'Fix #42 "quoted" title');
});

test('unquoted values strip comments only after whitespace (YAML rule)', () => {
  assert.equal(readFrontmatterField('---\nsource_title: Hello # note\n---\n', 'source_title'), 'Hello');
  assert.equal(readFrontmatterField('---\nsource_title: word#tag\n---\n', 'source_title'), 'word#tag');
});

test('an unterminated frontmatter block is never scanned into the body', () => {
  assert.equal(readFrontmatterField('---\nsource_title: "X"', 'source_title'), null);
});

test('push meta source_title wins over frontmatter re-parsing', () => {
  const store = new HandoffStore();
  const rec = store.add({
    id: 'p1',
    meta: { source_title: 'Meta Title' },
    markdown: '---\nsource_title: "Other"\n---\nx',
  });
  assert.equal(rec.source_title, 'Meta Title');
});
