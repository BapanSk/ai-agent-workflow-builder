import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, renderTemplate, renderValue } from '../src/expr.js';

const ctx = {
  input: { app: 'checkout', risk: 'critical' },
  outputs: [null, { severity: 'critical' }, { result: true }],
  steps: { 'Assess release risk': { severity: 'critical' } },
  env: { HANDLER_BASE_URL: 'http://localhost:4000' },
};

test('evaluate: equality and inequality', () => {
  assert.equal(evaluate("input.risk == 'critical'", ctx), true);
  assert.equal(evaluate("input.risk == 'low'", ctx), false);
  assert.equal(evaluate("input.risk != 'low'", ctx), true);
});

test('evaluate: comparisons', () => {
  assert.equal(evaluate('outputs[2].result == true', ctx), true);
  assert.equal(evaluate("steps['Assess release risk'].severity == 'critical'", ctx), true);
});

test('evaluate: boolean operators', () => {
  assert.equal(evaluate("input.risk == 'critical' && outputs[2].result == true", ctx), true);
  assert.equal(evaluate("input.risk == 'critical' || input.risk == 'low'", ctx), true);
  assert.equal(evaluate("!(input.risk == 'low')", ctx), true);
});

test('evaluate: undefined / null', () => {
  assert.equal(evaluate('input.missing == null', ctx), true);
  assert.equal(evaluate('input.missing', ctx), undefined);
});

test('evaluate: invalid expression throws', () => {
  assert.throws(() => evaluate('input..broken', ctx));
});

test('renderTemplate interpolates {{ expr }}', () => {
  const out = renderTemplate(
    'Release {{input.app}} severity {{steps["Assess release risk"].severity}}',
    ctx,
  );
  assert.equal(out, 'Release checkout severity critical');
});

test('renderTemplate leaves unknown vars empty', () => {
  assert.equal(renderTemplate('x={{missing.path}}y', ctx), 'x=y');
});

test('renderValue deep-renders objects/arrays', () => {
  const out = renderValue(
    { app: '{{input.app}}', nested: { sev: '{{outputs[1].severity}}' }, list: ['{{env.HANDLER_BASE_URL}}'] },
    ctx,
  );
  assert.deepEqual(out, {
    app: 'checkout',
    nested: { sev: 'critical' },
    list: ['http://localhost:4000'],
  });
});
