/** 工程智能的共享数据模型：节点、边、检索、记忆、关联。 */

export type CodeNodeType =
  | 'Project'
  | 'Module'
  | 'File'
  | 'Package'
  | 'Class'
  | 'Interface'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'Type';

export type CodeEdgeType =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'CALLS'
  | 'REFERENCES'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'DEFINES'
  | 'DEPENDS_ON';

export type EdgeConfidence = 'EXACT' | 'HIGH' | 'POSSIBLE' | 'UNKNOWN';
export type EdgeSource = 'LSP' | 'AST' | 'STATIC_ANALYSIS' | 'CGC' | 'MANUAL';
export type ResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved' | 'dynamic' | 'inferred';
export type SymbolStatus = 'confirmed' | 'provisional';

export interface CodeNode {
  projectId: string;
  nodeId: string;
  nodeType: CodeNodeType;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  generation: number;
  /** 稳定身份；旧库迁移时先回填为 nodeId，后续索引逐步写入。 */
  symbolId?: string;
  /** Java 在当前阶段只能是 provisional；Gate 3 后再冻结。 */
  symbolStatus?: SymbolStatus;
  moduleId?: string;
  signature?: string;
}

export interface CodeEdge {
  projectId: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: CodeEdgeType;
  confidence: EdgeConfidence;
  source: EdgeSource;
  filePath?: string;
  line?: number;
  generation: number;
  resolutionStatus?: ResolutionStatus;
  /** 同一调用点的多个候选共享；用于 ambiguous 调用。 */
  callSiteId?: string;
}

export interface SearchDoc {
  docId: string;
  projectId: string;
  filePath: string;
  nodeId?: string;
  kind: string;
  name: string;
  content: string;
  generation: number;
}

export interface SearchHit {
  docId: string;
  filePath: string;
  nodeId?: string;
  name: string;
  content: string;
  source: 'fts' | 'like';
  score: number;
}

export type MemoryStatus = 'candidate' | 'confirmed' | 'deprecated';

export interface MemoryFact {
  projectId: string;
  factId: string;
  kind: 'fact' | 'decision' | 'constraint' | 'issue' | 'solution' | 'debate';
  title: string;
  content: string;
  source: string;
  sourceRef?: string;
  status: MemoryStatus;
  confidence: number;
  validFrom?: number;
  validTo?: number;
  createdAt: number;
  updatedAt: number;
}

export type LinkStatus = 'active' | 'needs_relink' | 'pending_review' | 'invalid' | 'deleted';

export interface CodeMemoryLink {
  id: string;
  projectId: string;
  symbolKey: string;
  symbolLocator: string;
  symbolFingerprint: string;
  memoryEntityId: string;
  linkType: string;
  confidence: number;
  status: LinkStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RetrievalItem {
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
  /** 记忆状态；代码项没有。 */
  status?: MemoryStatus;
  stale?: boolean;
}

export interface RetrievalResult {
  items: RetrievalItem[];
  sources: { graph: boolean; fullText: boolean; memory: boolean; vector: boolean };
  warnings: string[];
  stale: boolean;
}
