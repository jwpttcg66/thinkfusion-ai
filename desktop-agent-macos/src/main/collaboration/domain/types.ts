/**
 * V3 协作引擎的核心契约。
 *
 * 这里是“目标契约”，P1 才接线；当前 legacy 路径不引用。
 * 详细语义见 docs/implementation/P1-002-DOMAIN-RUNTIME-CONTRACT.md。
 */

export type ModelScope = 'local' | 'remote' | 'hybrid';

export interface Goal {
  goalId: string;
  workspace: 'knowledge' | 'engineering' | 'general';
  /** 用户原话，逐字保留。 */
  statement: string;
  constraints: string[];
  acceptance: string[];
  createdAt: number;
}

export interface Budget {
  maxCalls: number;
  maxMs: number;
  usedCalls: number;
  startedAt: number;
}

export interface Policy {
  modelScope: ModelScope;
  includeWeb: boolean;
  minParticipants: number;
  allowWebQuestioner: boolean;
  budget: Budget;
}

export type CapabilityId =
  | 'reasoning' | 'knowledge' | 'web-research'
  | 'code-search' | 'code-read' | 'symbols' | 'impact'
  | 'java' | 'test-run' | 'shell-read'
  | 'review' | 'verification';

export interface AgentCapabilities {
  kind: 'web' | 'local' | 'cloud' | 'cli';
  canSystemPrompt: boolean;
  canUseTools: boolean;
  canStream: boolean;
  canSeeOtherAgents: boolean;
  maxConcurrency: number;
  costClass: 'low' | 'medium' | 'high';
  requiresLogin?: boolean;
}

export interface Participant extends AgentCapabilities {
  participantId: string;
  label: string;
  capabilities: CapabilityId[];
  available: boolean;
  unavailableReason?: string;
}

export interface TaskEnvelope {
  question: string;
  scope?: { paths?: string[]; symbols?: string[]; sources?: string[] };
  acceptance: string[];
  outputSchema?: Record<string, unknown>;
  evidenceRequired: boolean;
}

export type TaskKind = 'analyze' | 'research' | 'verify' | 'review' | 'execute' | 'synthesize';

/** A-03：协作行为只决定任务图，不新增 Runtime。 */
export type CollaborationBehavior = 'independent' | 'parallel' | 'progressive' | 'crosscheck';

export interface EngineeringTaskState {
  taskId: string;
  context: Record<string, unknown>;
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
  testReports: Array<Record<string, unknown>>;
  build?: Record<string, unknown>;
  review?: Record<string, unknown>;
  worktree?: { dir: string; branch: string };
}

export interface TaskSpec {
  taskId: string;
  goalId: string;
  kind: TaskKind;
  envelope: TaskEnvelope;
  dependsOn: string[];
  requiredCapabilities: CapabilityId[];
  timeoutMs?: number;
  degradable?: boolean;
  context?: Record<string, unknown>;
}

export type TaskStatus =
  | 'pending' | 'assigned' | 'running' | 'retrying'
  | 'done' | 'failed' | 'blocked' | 'skipped' | 'cancelled';

export interface Attempt {
  attemptId: string;
  taskId: string;
  participantId: string;
  number: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  error?: { code: string; message: string };
}

export interface TaskRuntimeState {
  taskId: string;
  status: TaskStatus;
  attempts: Attempt[];
  currentAttemptId?: string;
  reason?: string;
}

export interface TaskGraph {
  goalId: string;
  tasks: TaskSpec[];
  maxDepth: number;
  createdAt: number;
}

export interface Plan {
  planId: string;
  goalId: string;
  version: number;
  supersedes?: string;
  policy: Policy;
  tasks: TaskSpec[];
  participants: Array<{ participantId: string; reason: string }>;
  skipped: Array<{ participantId: string; reason: string }>;
  stopWhen: string[];
  reason: string;
  behavior?: CollaborationBehavior;
  behaviorReason?: string;
  createdAt: number;
}

export interface Assignment {
  assignmentId: string;
  taskId: string;
  participantId: string;
  reason: string;
  contextRefs: string[];
  assignedAt: number;
}

export interface Observation {
  observationId: string;
  taskId: string;
  attemptId: string;
  participantId: string;
  status: 'done' | 'failed' | 'cancelled';
  text?: string;
  toolCalls?: Array<{ tool: string; args: unknown; resultHash?: string }>;
  evidenceRefs: string[];
  error?: { code: string; message: string };
  startedAt: number;
  endedAt: number;
}

export type EvidenceKind = 'web' | 'code' | 'execution' | 'knowledge' | 'tool';

export interface EvidenceRef {
  evidenceId: string;
  kind: EvidenceKind;
  scope: { goalId: string; taskId?: string };
  source: { uri?: string; commit?: string; snapshot?: string; capturedAt: number };
  locator?: { path: string; startLine?: number; endLine?: number };
  hash: string;
  trust: 'verified' | 'unverified' | 'degraded';
  summary: string;
  legacy?: { packId: string; itemId: string };
}

export interface Claim {
  claimId: string;
  goalId: string;
  taskId?: string;
  text: string;
  kind: 'fact' | 'inference' | 'assumption' | 'recommendation' | 'prediction';
  source: { participantId?: string; observationId?: string; evidenceId?: string };
  scope?: 'code' | 'runtime' | 'world';
  createdAt: number;
}

export interface Conflict {
  conflictId: string;
  goalId: string;
  claimA: string;
  claimB: string;
  type: 'factual' | 'logical' | 'scope' | 'definitional' | 'evidence_conflict';
  matters: boolean;
  status: 'detected' | 'dismissed' | 'confirmed';
  detectedBy: 'rule' | 'planner' | 'reviewer';
  evidenceRefs: string[];
  createdAt: number;
}

export interface Dispute {
  disputeId: string;
  conflictId: string;
  goalId: string;
  status: 'open' | 'resolved' | 'unresolved';
  openedAt: number;
  resolvedAt?: number;
  resolution?: {
    relation: 'supports' | 'contradicts' | 'context' | 'unverified';
    evidenceRefs: string[];
  };
}

export interface Verdict {
  claimId: string;
  relation: 'supports' | 'contradicts' | 'context' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
  evidenceRefs: string[];
}

export type Verification = Verdict;

export type StopReason =
  | 'acceptance_satisfied' | 'no_new_information'
  | 'budget_exhausted' | 'blocked' | 'user_cancelled' | 'failed';

export interface Deliverable {
  deliverableId: string;
  goalId: string;
  kind: 'answer' | 'research' | 'knowledge_map' | 'engineering_change' | 'test_report';
  content: string;
  claims: Claim[];
  verifications: Verdict[];
  openQuestions: string[];
  stopReason: StopReason;
  evidenceCoverage: number;
  createdAt: number;
}

export interface CollaborationState {
  version: 1;
  goal: Goal;
  activePlan: Plan;
  planHistory: Plan[];
  taskStates: TaskRuntimeState[];
  assignments: Assignment[];
  observations: Observation[];
  evidence: EvidenceRef[];
  claims: Claim[];
  conflicts: Conflict[];
  disputes: Dispute[];
  budget: Budget;
  replans: Array<{ at: number; reason: string; added: string[]; removed: string[] }>;
  stop?: { reason: StopReason; at: number };
  deliverable?: Deliverable;
  engineering?: EngineeringTaskState;
  updatedAt: number;
}

export interface QuestionInput {
  kind: 'question';
  question: string;
  transcript?: Array<{ source: string; text: string }>;
}

export interface QuestionerInput {
  kind: 'questioner';
  question: string;
  transcript: Array<{ source: string; text: string }>;
}

export interface ContractInput {
  kind: 'contract';
  question: string;
  schema: Record<string, unknown>;
  data?: Record<string, unknown>;
  constraints?: { tools?: string[]; permission?: string; timeoutMs?: number };
}

export type ModelInput = QuestionInput | QuestionerInput | ContractInput;
