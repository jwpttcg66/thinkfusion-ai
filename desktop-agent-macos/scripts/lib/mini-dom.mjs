/**
 * A very small DOM, for running page scripts against fixed HTML fixtures.
 *
 * Why this exists: the citation reader is a string of JavaScript that Electron
 * executes in a real page. The part that breaks is never "the JS syntax" — it
 * is "which node did it pick, and what did it do with a relative href". Those
 * questions can only be answered by running it against markup, so the tests
 * need a DOM and the repo has no jsdom dependency.
 *
 * Scope is deliberately narrow: element tree, attributes, class list, text,
 * visibility, and `querySelectorAll` for the handful of selector shapes the
 * provider profiles use (tag, `.class`, `tag.class`, `[attr]`, `[attr="v"]`,
 * `[attr*="v"]`, and a two-part descendant). Anything else throws, loudly —
 * a silently unsupported selector in a test is a false pass.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

class FakeNode {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.text = '';
    this.parent = null;
  }

  get classList() {
    return (this.attrs.class ?? '').split(/\s+/).filter(Boolean);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  get textContent() {
    return this.text + this.children.map(child => child.textContent).join('');
  }

  get innerText() {
    return this.textContent;
  }

  get parentElement() {
    return this.parent;
  }

  getBoundingClientRect() {
    if (isHidden(this)) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    return { width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24 };
  }

  querySelectorAll(selector) {
    return queryAll([this], selector).filter(node => node !== this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function parseAttrs(raw) {
  const attrs = {};
  const pattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Fixture HTML → element tree. Comments and doctype are skipped. */
export function parseHtml(html) {
  const root = new FakeNode('#root', {});
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/gi;
  let cursor = 0;
  let match;

  while ((match = tokens.exec(html))) {
    const text = html.slice(cursor, match.index);
    if (text.trim()) stack[stack.length - 1].text += text;
    cursor = tokens.lastIndex;
    if (!match[2]) continue; // comment or doctype

    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const node = new FakeNode(tag, parseAttrs(match[3] ?? ''));
    stack[stack.length - 1].children.push(node);
    node.parent = stack[stack.length - 1];
    if (!match[4] && !VOID_TAGS.has(tag)) stack.push(node);
  }

  const tail = html.slice(cursor);
  if (tail.trim()) stack[stack.length - 1].text += tail;
  return root;
}

function styleOf(node) {
  const raw = node.getAttribute('style') ?? '';
  const style = { display: 'block', visibility: 'visible', opacity: '1' };
  for (const part of raw.split(';')) {
    const [name, value] = part.split(':').map(item => item?.trim());
    if (!name || !value) continue;
    if (name === 'display' || name === 'visibility' || name === 'opacity') style[name] = value;
  }
  return style;
}

function isHidden(node) {
  for (let current = node; current; current = current.parent) {
    if (current.getAttribute('hidden') !== null) return true;
    const style = styleOf(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
  }
  return false;
}

function matches(node, selector) {
  const pattern = /^([a-zA-Z][\w:-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/;
  const parsed = selector.match(pattern);
  if (!parsed) throw new Error(`mini-dom 不支持的选择器：${selector}`);
  const [, tag, rest] = parsed;
  if (tag && node.tag !== tag.toLowerCase()) return false;
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
  for (const part of parts) {
    if (part.startsWith('.')) {
      if (!node.classList.includes(part.slice(1))) return false;
      continue;
    }
    const attr = part.slice(1, -1);
    const equals = attr.match(/^([\w:-]+)="([^"]*)"$/);
    const contains = attr.match(/^([\w:-]+)\*="([^"]*)"$/);
    const bare = attr.match(/^([\w:-]+)$/);
    if (equals) {
      if (node.getAttribute(equals[1]) !== equals[2]) return false;
    } else if (contains) {
      if (!(node.getAttribute(contains[1]) ?? '').includes(contains[2])) return false;
    } else if (bare) {
      if (node.getAttribute(bare[1]) === null) return false;
    } else {
      throw new Error(`mini-dom 不支持的属性选择器：${selector}`);
    }
  }
  return true;
}

function descendants(node) {
  const found = [];
  const walk = current => {
    for (const child of current.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

function queryAll(roots, selector) {
  const steps = selector.trim().split(/\s+/);
  let context = roots;
  for (const step of steps) {
    const found = [];
    for (const root of context) {
      for (const node of descendants(root)) {
        if (matches(node, step) && !found.includes(node)) found.push(node);
      }
    }
    context = found;
  }
  return context;
}

/**
 * The object shape a page script sees as `document` / `location` /
 * `getComputedStyle`.
 */
export function createDocument(html, location = 'https://example.com/chat') {
  const root = parseHtml(html);
  const titleNode = descendants(root).find(node => node.tag === 'title');
  const document = {
    title: titleNode ? titleNode.textContent.trim() : '',
    querySelectorAll: selector => queryAll([root], selector),
    querySelector: selector => queryAll([root], selector)[0] ?? null
  };
  return {
    document,
    location: { href: location },
    getComputedStyle: node => styleOf(node),
    root
  };
}
