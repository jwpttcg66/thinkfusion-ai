/**
 * 工程理解：符号、依赖、变更影响（V2.1 Phase E）。
 *
 * `scanProject` 只回答「这个工程里有哪些文件、哪些片段和问题有关」。但工程
 * 问题真正要的是关系：这个方法定义在哪、谁在调它、这个文件被谁依赖、改它会
 * 波及什么。这一层把那些关系算出来，让主导人拿到的是结构事实，而不是一堆
 * 通过关键词命中的片段。
 *
 * 三条边界：
 * - **不引 AST。** 任务书明确要求「不要未经论证就引入完整 AST、向量库或全量
 *   调用图」。这里用正则做轻量识别，结论里会说明是「按正则识别」——宁可说
 *   清方法，也不假装精确。
 * - **不碰网络、不执行任何命令。** 纯字符串处理。
 * - **只处理已读进内存的文件。** 调用方（scanProject）已经做过目录边界、
 *   凭证排除、大小上限这些事，这里不再重开文件。
 */

export interface CodeFile {
  /** 相对工程根目录的路径，统一用 `/`。 */
  rel: string;
  content: string;
}

export interface SymbolHit {
  path: string;
  line: number;
  kind: string;
  name: string;
}

export interface ModuleEdge {
  from: string;
  to: string;
  line: number;
  specifier: string;
}

export interface ModuleGraph {
  /** 参与分析的工程内文件。 */
  nodes: string[];
  edges: ModuleEdge[];
  /** 指向工程外的包（react、node:fs…），只计数，不猜测它们内部结构。 */
  external: Array<{ specifier: string; count: number }>;
}

const DEFINITION_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'function', pattern: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'class', pattern: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'interface', pattern: /(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'type', pattern: /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g },
  { kind: 'const', pattern: /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/g },
  { kind: 'go-func', pattern: /(?:^|\n)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g },
  { kind: 'py-def', pattern: /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g },
  { kind: 'java-method', pattern: /(?:^|\n)\s*(?:public|private|protected)\s+[\w<>[\]]+\s+([A-Za-z_]\w*)\s*\(/g }
];

const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?|export\s+(?:type\s+)?[\w*{}\s,]+\s+from\s+|(?:const|let|var)\s+[\w{}\s,]+\s*=\s*require\s*\()\s*['"]([^'"]+)['"]/g;

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.go', '.java'];

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** 找出文件里的定义。同名多次定义时保留第一次出现的位置。 */
export function extractSymbols(file: CodeFile): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of DEFINITION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      const name = match[1];
      if (!name) continue;
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const offset = match.index + (match[0].length - match[0].trimStart().length);
      hits.push({ path: file.rel, line: lineAt(file.content, offset), kind, name });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** 找出文件里出现的调用点（`name(`），排除定义本身那一行。 */
export function findCallSites(files: readonly CodeFile[], name: string): Array<{ path: string; line: number; text: string }> {
  const hits: Array<{ path: string; line: number; text: string }> = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\w$.])${escaped}\\s*(?:\\.call\\(|\\.apply\\(|\\()`, 'g');
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!pattern.test(line)) {
        pattern.lastIndex = 0;
        continue;
      }
      pattern.lastIndex = 0;
      if (new RegExp(`(?:function|class|interface|type|const|let|var)\\s+${escaped}\\b`).test(line)) continue;
      hits.push({ path: file.rel, line: index + 1, text: line.trim().slice(0, 140) });
      if (hits.length >= 40) return hits;
    }
  }
  return hits;
}

/** 把 `./x`、`../y/z` 解析成工程内的相对路径；解析不出来就返回 null（外部依赖）。 */
export function resolveSpecifier(fromRel: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const baseParts = fromRel.split('/').slice(0, -1);
  const specParts = specifier.split('/');
  const parts = [...baseParts];
  for (const part of specParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join('/');
  const candidates = [joined, ...RESOLVE_EXTENSIONS.map(ext => `${joined}${ext}`)];
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${joined}/index${ext}`);
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** 解析 import/require，建成工程内的有向依赖图。 */
export function buildModuleGraph(files: readonly CodeFile[]): ModuleGraph {
  const known = new Set(files.map(file => file.rel));
  const edges: ModuleEdge[] = [];
  const externalCounts = new Map<string, number>();
  for (const file of files) {
    IMPORT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_PATTERN.exec(file.content)) !== null) {
      const specifier = match[1];
      if (!specifier) continue;
      const line = lineAt(file.content, match.index);
      const target = resolveSpecifier(file.rel, specifier, known);
      if (target) edges.push({ from: file.rel, to: target, line, specifier });
      else if (!specifier.startsWith('.')) externalCounts.set(specifier, (externalCounts.get(specifier) ?? 0) + 1);
    }
  }
  return {
    nodes: files.map(file => file.rel),
    edges,
    external: [...externalCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([specifier, count]) => ({ specifier, count }))
  };
}

/**
 * 改这个文件会波及谁：反向依赖，最多两层。
 *
 * 只算工程内的静态 import；动态导入、字符串拼出来的路径都看不到，所以结论
 * 里必须写「按静态 import 估算」，不能当成完整影响面。
 */
export function impactOf(
  graph: ModuleGraph,
  target: string,
  depth = 2
): { direct: ModuleEdge[]; indirect: Array<{ path: string; via: string }> } {
  const direct = graph.edges.filter(edge => edge.to === target);
  const seen = new Set(direct.map(edge => edge.from));
  let frontier = [...seen];
  const indirect: Array<{ path: string; via: string }> = [];
  for (let level = 1; level < depth; level += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of graph.edges.filter(item => item.to === node)) {
        if (edge.from === target || seen.has(edge.from)) continue;
        seen.add(edge.from);
        indirect.push({ path: edge.from, via: node });
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return { direct, indirect };
}

/** 顶层目录与入口文件：回答「这个工程长什么样」时先给这一层。 */
export function architectureOf(files: readonly CodeFile[]): {
  directories: Array<{ path: string; files: number }>;
  entries: string[];
} {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.rel.split('/');
    const key = parts.length === 1 ? '(根目录)' : parts[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = files
    .map(file => file.rel)
    .filter(rel => /(^|\/)(index|main|app|server|bootstrap)\.(ts|tsx|js|jsx|mjs|py|go|java)$/i.test(rel))
    .slice(0, 8);
  return {
    directories: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([path, filesCount]) => ({ path, files: filesCount })),
    entries
  };
}

export type AnalysisKind = 'architecture' | 'symbols' | 'callers' | 'dependencies' | 'impact';

/** 问题里出现了什么，就决定算哪几种关系。纯规则，可读可测。 */
export function analysisKindsFor(question: string): AnalysisKind[] {
  const kinds = new Set<AnalysisKind>();
  if (/(结构|架构|分层|目录|模块划分|概览|组成|入口)/.test(question)) kinds.add('architecture');
  if (/(符号|定义|函数|方法|类|接口|在哪|声明)/.test(question)) kinds.add('symbols');
  if (/(调用|谁用|引用|使用处|调用链|调用方)/.test(question)) kinds.add('callers');
  if (/(依赖|依赖关系|引用关系|import)/i.test(question)) kinds.add('dependencies');
  if (/(影响|波及|改动|重构|删除|移到)/.test(question)) kinds.add('impact');
  // 一个问题都没命中结构类词时，至少给一份符号索引——「分析这个项目」通常
  // 就是想先看到有什么。
  if (kinds.size === 0) kinds.add('symbols');
  return [...kinds];
}

/** 从问题里猜一个目标文件或符号，用于调用点 / 影响面。 */
export function guessTarget(question: string, files: readonly CodeFile[], symbols: readonly SymbolHit[]): {
  file?: string;
  symbol?: string;
} {
  const fileMatch = question.match(/([\w./-]+\.(?:ts|tsx|js|jsx|mjs|py|go|java|vue))/i);
  if (fileMatch) {
    const wanted = fileMatch[1].replace(/^\.\//, '');
    const hit = files.find(file => file.rel === wanted || file.rel.endsWith(`/${wanted}`));
    if (hit) return { file: hit.rel };
  }
  const words = question.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  for (const word of words) {
    const hit = symbols.find(symbol => symbol.name === word);
    if (hit) return { file: hit.path, symbol: hit.name };
  }
  return {};
}

/**
 * 把分析结果拼成给主导人的一段材料。
 *
 * 明确写「按正则识别」「按静态 import 估算」：这些结论是结构线索，不是
 * 编译器级别的精确结果，主导人引用时要带着这个限定。
 */
export function analyzeForQuestion(files: readonly CodeFile[], question: string): string {
  const kinds = analysisKindsFor(question);
  const symbols = files.flatMap(extractSymbols);
  const graph = buildModuleGraph(files);
  const target = guessTarget(question, files, symbols);
  const sections: string[] = [];

  if (kinds.includes('architecture')) {
    const arch = architectureOf(files);
    sections.push(
      [
        '【结构概览】',
        `顶层目录：${arch.directories.map(item => `${item.path}(${item.files} 个文件)`).join('、') || '（空）'}`,
        `可能的入口：${arch.entries.join('、') || '未识别到 index/main/app 一类入口'}`
      ].join('\n')
    );
  }

  if (kinds.includes('symbols')) {
    const relevant = target.symbol
      ? symbols.filter(symbol => symbol.name === target.symbol)
      : symbols;
    const capped = relevant.slice(0, 30);
    sections.push(
      [
        '【符号索引（按正则识别，不是编译器级结果）】',
        capped.length === 0
          ? '没有识别到函数/类/接口定义。'
          : capped.map(symbol => `${symbol.path}:${symbol.line}　${symbol.kind} ${symbol.name}`).join('\n')
      ].join('\n')
    );
  }

  if (kinds.includes('callers')) {
    if (target.symbol) {
      const sites = findCallSites(files, target.symbol);
      // 定义位置一起给：只说「谁调用」不说「定义在哪」，读的人还得再找一遍。
      const definition = symbols.find(symbol => symbol.name === target.symbol);
      sections.push(
        [
          `【调用点】${target.symbol}（按文本匹配，可能包含同名函数）`,
          definition ? `定义：${definition.path}:${definition.line}` : '定义：没有识别到（可能是外部引入的符号）',
          sites.length === 0
            ? '没有找到调用它的地方。'
            : sites.map(site => `${site.path}:${site.line}　${site.text}`).join('\n')
        ].join('\n')
      );
    } else {
      sections.push('【调用点】问题里没有指明具体方法名，无法列出调用关系；可以说清是哪个方法后再分析。');
    }
  }

  if (kinds.includes('dependencies')) {
    const top = graph.edges.slice(0, 40);
    sections.push(
      [
        '【模块依赖（按静态 import 解析）】',
        top.length === 0
          ? '没有识别到工程内的 import 关系。'
          : top.map(edge => `${edge.from}:${edge.line} → ${edge.to}`).join('\n'),
        graph.external.length > 0
          ? `外部依赖：${graph.external.map(item => `${item.specifier}×${item.count}`).join('、')}`
          : '外部依赖：未识别到'
      ].join('\n')
    );
  }

  if (kinds.includes('impact')) {
    if (target.file) {
      const impact = impactOf(graph, target.file);
      sections.push(
        [
          `【变更影响】${target.file}（按静态 import 估算，动态导入看不到）`,
          impact.direct.length === 0
            ? '没有工程内文件直接 import 它。'
            : `直接依赖：${impact.direct.map(edge => edge.from).join('、')}`,
          impact.indirect.length === 0
            ? '没有第二层波及。'
            : `间接波及：${impact.indirect.map(item => `${item.path}（经由 ${item.via}）`).join('、')}`
        ].join('\n')
      );
    } else {
      sections.push('【变更影响】问题里没有指明具体文件，无法估算影响面；可以说清文件名后再分析。');
    }
  }

  const text = sections.join('\n\n');
  // 材料是给主导人的上下文，不是给人读的报告：超长只会挤掉真正的证据。
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…（分析结果过长，已截断）` : text;
}
