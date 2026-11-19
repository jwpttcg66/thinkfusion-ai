/**
 * P3-08：Java 先走文本/正则，不引入 JDT 核心依赖。
 */
export function isJavaFile(path: string): boolean {
  return path.endsWith('.java');
}

export function javaSupport(): { jdt: false; fallback: 'text'; reason: string } {
  return { jdt: false, fallback: 'text', reason: 'JDT 不是核心依赖；先用文本检索与正则' };
}
