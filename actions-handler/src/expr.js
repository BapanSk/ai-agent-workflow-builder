// Safe expression evaluator + template renderer for workflow steps.
//
// Supports a small, safe expression language (no eval / code execution):
//   literals: numbers, strings (single/double quotes), true/false/null
//   paths:    `input.risk`, `outputs[0].severity`, `steps["Name"].field`, `prev.result`
//   operators: == != > >= < <= && || ! ( )
//   template:  "Release {{input.app}} severity {{outputs[0].severity}}"
//
// `evaluate(expr, ctx)` resolves identifiers against the `ctx` object.
// `renderTemplate(str, ctx)` replaces every `{{ <expr> }}` with its value.

const TOKEN_RE = /^\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(true)|(false)|(null)|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|>=|<=|&&|\|\||[>]|<|[!])|(\()|(\))|(\[)|(\])|(\.)|(,))/;

function tokenize(input) {
  const tokens = [];
  let rest = input;
  while (rest.trim().length > 0) {
    const m = TOKEN_RE.exec(rest);
    if (!m) throw new Error(`Unexpected token in expression: ${JSON.stringify(rest.slice(0, 20))}`);
    tokens.push({ type: m[8] ? 'op' : m[9] ? 'lparen' : m[10] ? 'rparen' : m[11] ? 'lbracket' : m[12] ? 'rbracket' : m[13] ? 'dot' : m[14] ? 'comma' : 'value', value: m[0].trim() });
    rest = rest.slice(m[0].length);
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }
  peek() {
    return this.tokens[this.i];
  }
  next() {
    return this.tokens[this.i++];
  }
  expect(type) {
    const t = this.next();
    if (!t || t.type !== type) throw new Error(`Expected ${type}`);
    return t;
  }
  parse() {
    const node = this.parseOr();
    if (this.i < this.tokens.length) throw new Error(`Trailing tokens in expression`);
    return node;
  }
  parseOr() {
    let node = this.parseAnd();
    while (this.peek() && this.peek().value === '||') {
      this.next();
      node = { op: '||', left: node, right: this.parseAnd() };
    }
    return node;
  }
  parseAnd() {
    let node = this.parseCmp();
    while (this.peek() && this.peek().value === '&&') {
      this.next();
      node = { op: '&&', left: node, right: this.parseCmp() };
    }
    return node;
  }
  parseCmp() {
    const node = this.parseUnary();
    if (this.peek() && ['==', '!=', '>', '>=', '<', '<='].includes(this.peek().value)) {
      const op = this.next().value;
      return { op, left: node, right: this.parseUnary() };
    }
    return node;
  }
  parseUnary() {
    if (this.peek() && this.peek().value === '!') {
      this.next();
      return { op: '!', value: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'lparen') {
      this.next();
      const node = this.parseOr();
      this.expect('rparen');
      return node;
    }
    if (t.type === 'value') {
      this.next();
      if (t.value === 'true') return { type: 'lit', value: true };
      if (t.value === 'false') return { type: 'lit', value: false };
      if (t.value === 'null') return { type: 'lit', value: null };
      if (/^[\d.]+$/.test(t.value)) return { type: 'lit', value: Number(t.value) };
      if ((t.value.startsWith('"') && t.value.endsWith('"')) || (t.value.startsWith("'") && t.value.endsWith("'"))) {
        return { type: 'lit', value: t.value.slice(1, -1).replace(/\\(.)/g, '$1') };
      }
      // identifier path: root.member[..]..
      let node = { type: 'path', root: t.value, path: [] };
      while (this.peek()) {
        if (this.peek().type === 'dot') {
          this.next();
          const key = this.next();
          if (key.type !== 'value') throw new Error('Expected member name after .');
          node.path.push({ kind: 'key', value: key.value });
        } else if (this.peek().type === 'lbracket') {
          this.next();
          const idxNode = this.parseOr();
          this.expect('rbracket');
          node.path.push({ kind: 'index', value: idxNode });
        } else {
          break;
        }
      }
      return node;
    }
    throw new Error(`Unexpected token ${t.type}: ${t.value}`);
  }
}

function lookupPath(node, ctx) {
  let value = node.root === 'env' ? ctx.env : node.root === 'input' ? ctx.input : node.root === 'prev' ? ctx.prev : node.root === 'outputs' ? ctx.outputs : node.root === 'steps' ? ctx.steps : ctx[node.root];
  for (const part of node.path) {
    if (value == null) return undefined;
    if (part.kind === 'key') value = value[part.value];
    else {
      const idx = evalNode(part.value, ctx);
      value = value[idx];
    }
  }
  return value;
}

function evalNode(node, ctx) {
  if (node.type === 'lit') return node.value;
  if (node.type === 'path') return lookupPath(node, ctx);
  if (node.op === '!') return !evalNode(node.value, ctx);
  if (node.op === '&&') return Boolean(evalNode(node.left, ctx)) && Boolean(evalNode(node.right, ctx));
  if (node.op === '||') return Boolean(evalNode(node.left, ctx)) || Boolean(evalNode(node.right, ctx));
  const l = evalNode(node.left, ctx);
  const r = evalNode(node.right, ctx);
  const looseEq = (a, b) => (a === null || a === undefined) ? (b === null || b === undefined) : a === b;
  switch (node.op) {
    case '==': return looseEq(l, r);
    case '!=': return !looseEq(l, r);
    case '>': return l > r;
    case '>=': return l >= r;
    case '<': return l < r;
    case '<=': return l <= r;
    default: throw new Error(`Unknown operator ${node.op}`);
  }
}

export function evaluate(expr, ctx = {}) {
  const tokens = tokenize(String(expr ?? ''));
  if (tokens.length === 0) return undefined;
  const ast = new Parser(tokens).parse();
  return evalNode(ast, ctx);
}

export function renderTemplate(str, ctx = {}) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, expr) => {
    const value = evaluate(expr, ctx);
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

// Deep-render a JSON value: strings with {{...}} get interpolated, objects and
// arrays are walked recursively.
export function renderValue(value, ctx = {}) {
  if (typeof value === 'string') return renderTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderValue(v, ctx);
    return out;
  }
  return value;
}
