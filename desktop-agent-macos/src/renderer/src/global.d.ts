import type { AgentApi } from '../../shared/contracts';
import type { DetachedPageSaveApi } from '../../shared/export';
import type { TerminalWindowApi } from '../../shared/cli-agents';
declare global { interface Window { agentAPI: AgentApi; tfDetachedSave: DetachedPageSaveApi; tfTerminal: TerminalWindowApi } }
export {};
