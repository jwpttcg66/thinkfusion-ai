/**
 * TypeScript 语法树：只做「按需 AST」，不做全量索引。
 *
 * 用途只有一个：把 tsserver 给的 references 分成「调用」和「只是引用」。
 * 普通引用可能是类型声明、注解、方法引用——不能都当成调用。有 AST 才能
 * 确认「这个位置是一个 CallExpression 的被调用者」。
 *
 * 动态加载 `typescript`：没有安装时返回 null，上层把调用关系标成 POSSIBLE，
 * 不伪造「已确认」。不引新依赖、不下载。
 */

export interface AstImport {
  module: string;
  line: number;
}

export interface AstDeclaration {
  name: string;
  kind: string;
  line: number;
}

export interface AstSummary {
  imports: AstImport[];
  declarations: AstDeclaration[];
  calls: Array<{ callee: string; line: number }>;
  source: 'typescript-ast';
}

type TsModule = typeof import('typescript');

let cached: TsModule | null | undefined;

export async function loadTypeScript(): Promise<TsModule | null> {
  if (cached !== undefined) return cached;
  try {
    cached = (await import('typescript')) as unknown as TsModule;
  } catch {
    cached = null;
  }
  return cached;
}

function scriptKind(file: string): number {
  if (/\.tsx$/i.test(file)) return 4; // TSX
  if (/\.jsx$/i.test(file)) return 2; // JSX
  if (/\.(js|mjs|cjs)$/i.test(file)) return 1; // JS
  return 3; // TS
}

/** 引用位置是不是一次调用（CallExpression / NewExpression 的被调用者）。 */
export function isCallAt(
  ts: TsModule,
  sourceFile: import('typescript').SourceFile,
  line: number,
  character: number
): boolean {
  const position = ts.getPositionOfLineAndCharacter(sourceFile, line - 1, character - 1);
  let found = false;
  const visit = (node: import('typescript').Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      if (position >= expression.getStart(sourceFile) && position <= expression.getEnd()) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function parseSource(ts: TsModule, file: string, text: string): import('typescript').SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

const KIND_NAMES: Record<number, string> = {
  233: 'function',
  234: 'class',
  235: 'interface',
  236: 'type',
  257: 'variable',
  258: 'variable',
  259: 'variable',
  260: 'module',
  261: 'variable'
};

/** 文件结构摘要：imports / 声明 / 调用点；超过上限就截断。 */
export function summarizeAst(
  ts: TsModule,
  file: string,
  text: string,
  max = 200
): AstSummary {
  const sourceFile = parseSource(ts, file, text);
  const imports: AstImport[] = [];
  const declarations: AstDeclaration[] = [];
  const calls: Array<{ callee: string; line: number }> = [];

  const visit = (node: import('typescript').Node): void => {
    if (declarations.length + calls.length >= max * 2) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        module: node.moduleSpecifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      });
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
        ts.isVariableStatement(node)) && declarations.length < max
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            declarations.push({ name: declaration.name.text, kind: 'variable', line });
          }
        }
      } else if (node.name && ts.isIdentifier(node.name)) {
        const kind = KIND_NAMES[node.kind] ?? 'declaration';
        declarations.push({ name: node.name.text, kind, line });
      }
    } else if (ts.isCallExpression(node) && calls.length < max) {
      calls.push({
        callee: node.expression.getText(sourceFile).slice(0, 120),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { imports, declarations, calls, source: 'typescript-ast' };
}
