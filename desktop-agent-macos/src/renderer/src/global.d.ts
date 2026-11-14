import type { AgentApi } from '../../shared/contracts';
import type { DetachedPageSaveApi } from '../../shared/export';
declare global { interface Window { agentAPI: AgentApi; tfDetachedSave: DetachedPageSaveApi } }
export {};
