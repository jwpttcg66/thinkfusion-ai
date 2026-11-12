/** 工程智能外部配置：非敏感字段落 JSON，Neo4j 密码走 ApiKeyStore。 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write';
import type { CodeIntelligenceConfig, CodeIntelligenceMode, CodeIntelligencePatch } from '../../shared/code-intelligence';

interface StoredConfig {
  mode?: CodeIntelligenceMode;
  cgcEnabled?: boolean;
  graphitiEnabled?: boolean;
  neo4jUrl?: string;
  neo4jUser?: string;
}

export class CodeIntelligenceConfigStore {
  constructor(private readonly file: string) {}

  read(hasPassword: boolean): CodeIntelligenceConfig {
    let stored: StoredConfig = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoredConfig;
    } catch {
      // 不存在/损坏时从默认开始；外部能力不是启动前提。
    }
    return {
      mode: stored.mode === 'external' ? 'external' : 'local',
      cgcEnabled: stored.cgcEnabled !== false,
      graphitiEnabled: stored.graphitiEnabled !== false,
      neo4jUrl: typeof stored.neo4jUrl === 'string' ? stored.neo4jUrl : '',
      neo4jUser: typeof stored.neo4jUser === 'string' && stored.neo4jUser ? stored.neo4jUser : 'neo4j',
      passwordConfigured: hasPassword
    };
  }

  save(patch: CodeIntelligencePatch, current: CodeIntelligenceConfig): CodeIntelligenceConfig {
    const next: StoredConfig = {
      mode: patch.mode ?? current.mode,
      cgcEnabled: patch.cgcEnabled ?? current.cgcEnabled,
      graphitiEnabled: patch.graphitiEnabled ?? current.graphitiEnabled,
      neo4jUrl: patch.neo4jUrl === undefined ? current.neo4jUrl : patch.neo4jUrl.trim().slice(0, 2000),
      neo4jUser: patch.neo4jUser === undefined ? current.neo4jUser : patch.neo4jUser.trim().slice(0, 200) || 'neo4j'
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), 0o600);
    return { ...current, ...next, mode: next.mode ?? current.mode } as CodeIntelligenceConfig;
  }
}
