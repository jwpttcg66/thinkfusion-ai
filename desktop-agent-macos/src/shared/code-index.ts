/** 代码索引的界面协议（主进程 ↔ 渲染层）。 */

export type CodeIndexMode = 'CODE' | 'MEMORY' | 'HYBRID';

export interface CodeIndexStatus {
  projectId: string;
  generation: number | null;
  files: number;
  nodes: number;
  edges: number;
  docs: number;
  vectors: number;
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
  sources: { graph: boolean; fullText: boolean; memory: boolean; vector: boolean };
  warnings: string[];
  stale: boolean;
  context?: string;
  contextMeta?: { used: number; omitted: number; stale: boolean };
}


export interface CodeIndexMemoryInput {
  root: string;
  kind: 'fact' | 'decision' | 'constraint' | 'issue' | 'solution' | 'debate';
  title: string;
  content: string;
  source: string;
  sourceRef?: string;
  status?: 'candidate' | 'confirmed';
  confidence?: number;
}

export interface CodeIndexMemory {
  projectId: string;
  factId: string;
  kind: CodeIndexMemoryInput['kind'];
  title: string;
  content: string;
  source: string;
  status: 'candidate' | 'confirmed' | 'deprecated';
  confidence: number;
  createdAt: number;
  updatedAt: number;
}


export interface CodeIndexVectorResult {
  count: number;
  model: string;
}


export interface CodeIndexLinkInput {
  root: string;
  filePath: string;
  line: number;
  memoryEntityId: string;
  linkType?: string;
}

export interface CodeIndexLink {
  id: string;
  projectId: string;
  symbolKey: string;
  memoryEntityId: string;
  linkType: string;
  confidence: number;
  status: string;
}
