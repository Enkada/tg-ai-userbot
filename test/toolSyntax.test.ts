// Tool-call parsing (src/toolSyntax.ts). The malformed closers are the shapes seen from V4 Flash /
// V4 Flash 0731 in the 2026-10-11 model A/B and in prod rows; the prose around them is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateToolCall, parseToolCall, stripToolCalls } from '../src/toolSyntax.ts';

const SELFIE = '{"name": "send_selfie", "arguments": {"prompt": "selfie at my desk, morning light"}}';
const SEARCH = '{"name": "web_search", "arguments": {"query": "deepseek v4 flash price"}}';

const CLOSERS = [
  '</tool_call>',
  '</tool_calls>',
  '</tool_code>',
  '</tool_result>',
  '</tool_report>',
  '</tool_cost>',
  '</tool_content>',
  '</tool_callback>',
  '</tool_cal>',
  '</tool_c>',
  '</tool_called',
  '</tool_callsysys',
  '</TOOL_CALL>',
  '', // no closer at all
];

for (const closer of CLOSERS) {
  test(`parses a call closed with ${JSON.stringify(closer)}`, () => {
    const call = parseToolCall(`<tool_call>${SELFIE}${closer}`);
    assert.deepEqual(call, { name: 'send_selfie', arguments: { prompt: 'selfie at my desk, morning light' } });
  });

  test(`strips prose-then-call closed with ${JSON.stringify(closer)}`, () => {
    const text = `ugh, fine. hold on\n<tool_call>${SELFIE}${closer}`;
    assert.equal(stripToolCalls(text), 'ugh, fine. hold on');
  });
}

test('drops an invented continuation glued to a mangled closer', () => {
  const text = `<tool_call>${SEARCH}</tool_calldouble checked, it's $0.15 per million`;
  assert.equal(parseToolCall(text)?.name, 'web_search');
  assert.equal(stripToolCalls(text), '');
});

test('drops text after a correct closer too (matches what streaming showed)', () => {
  const text = `brb\n<tool_call>${SEARCH}</tool_call>\nok so it says 15 cents`;
  assert.equal(stripToolCalls(text), 'brb');
});

test('accepts the rarer openers, case-insensitively', () => {
  for (const opener of ['<tool_calls>', '<tool_code>', '<TOOL_CALL>']) {
    assert.equal(parseToolCall(`${opener}${SEARCH}${opener.replace('<', '</')}`)?.name, 'web_search', opener);
  }
});

test('tolerates whitespace and newlines around the JSON', () => {
  assert.equal(parseToolCall(`<tool_call>\n  ${SEARCH}\n</tool_call>`)?.name, 'web_search');
});

test('braces and quotes inside string values do not end the object early', () => {
  const json = '{"name": "send_selfie", "arguments": {"prompt": "hoodie with a \\"}\\" print, {curly} hair"}}';
  const call = parseToolCall(`<tool_call>${json}</tool_cost>`);
  assert.equal(call?.arguments.prompt, 'hoodie with a "}" print, {curly} hair');
});

test('a call without arguments gets an empty object', () => {
  assert.deepEqual(parseToolCall('<tool_call>{"name": "web_search"}</tool_call>'), { name: 'web_search', arguments: {} });
});

test('garbled calls are not calls, but are still cut from the text', () => {
  const garbled = [
    '<tool_call>{"name": "send_selfie", "arguments": {"prompt": "unterminated',
    '<tool_call>{"arguments": {"prompt": "no name"}}</tool_call>',
    '<tool_call>{"name": 42}</tool_call>',
    '<tool_call>not json at all</tool_call>',
    '<tool_call>',
  ];
  for (const g of garbled) {
    const span = locateToolCall(`fine\n${g}`);
    assert.ok(span, g);
    assert.equal(span.call, null, g);
    assert.equal(stripToolCalls(`fine\n${g}`), 'fine', g);
  }
});

test('plain prose is untouched (only trimmed)', () => {
  for (const text of ['  just a normal reply  ', 'talking about <tool> tags and {json}', 'a [bracket] line', '']) {
    assert.equal(locateToolCall(text), null);
    assert.equal(stripToolCalls(text), text.trim());
  }
});

test('a lone closer in prose is not an opener', () => {
  assert.equal(locateToolCall('he typed </tool_call> at me'), null);
});
