/** 代码索引的界面协议（主进程 ↔ 渲染层）。 */

export type CodeIndexMode = 'CODE' | 'MEMORY' | 'HYBRID';

export interface CodeIndexStatus {
  projectId: string;
  generation: number | null;
  files: number;
  nodes: number;
  edges: number;
  docs: number;
}

export interface CodeIndexSearchInput {
  root: string;
  query: string;
  mode?: CodeIndexMode;
  limit?: number;
  context?: boolean;
}

export interface CodeIndexSearchItem {
  kind: 'code' | 'memory';
  id: string;
  title: string;
  content: string;
  source: string;
  confidence: number;
  filePath?: string;
  line?: number;
  validFrom?: number;
  validTo?: number;
  status?: 'candidate' | 'confirmed' | 'deprecated';
  stale?: boolean;
}

export interface CodeIndexSearchResult {
  items: CodeIndexSearchItem[];
  sources: { graph: boolean; fullText: boolean; memory: boolean };
  warnings: string[];
  stale: boolean;
  context?: string;
  contextMeta?: { used: number; omitted: number; stale: boolean };
}
