/** 工程智能的运行模式与外部服务配置（界面协议）。 */

export type CodeIntelligenceMode = 'local' | 'external';

export interface CodeIntelligenceConfig {
  mode: CodeIntelligenceMode;
  cgcEnabled: boolean;
  graphitiEnabled: boolean;
  /** Neo4j HTTP 事务端点，例如 http://127.0.0.1:7474。 */
  neo4jUrl: string;
  neo4jUser: string;
  /** 只回传是否已保存密码，不回传明文。 */
  passwordConfigured: boolean;
}

export interface CodeIntelligencePatch {
  mode?: CodeIntelligenceMode;
  cgcEnabled?: boolean;
  graphitiEnabled?: boolean;
  neo4jUrl?: string;
  neo4jUser?: string;
  /** 空字符串表示清除已保存密码。 */
  password?: string;
}

export interface CodeIntelligenceStatus {
  configured: boolean;
  mode: CodeIntelligenceMode;
  cgc: 'ready' | 'disabled' | 'error';
  graphiti: 'ready' | 'disabled' | 'error';
  detail?: string;
  lastCheckedAt: number;
}
