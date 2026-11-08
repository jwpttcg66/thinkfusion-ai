/**
 * 把两份 .md 读成运行时状态。
 *
 * 内置文件在 `resources/expertise/`（开发态从 app.getAppPath() 找，打包后从
 * process.resourcesPath 找）；用户可以在 userData/expertise/ 下放同名文件覆盖。
 * 用户文件一旦存在就**只**用它——写坏了要明确报错，不能悄悄退回内置，否则
 * 界面上看着像「替换生效了」，实际注入的还是旧内容。
 *
 * 这里不缓存：设置页每次读清单都重新读盘，用户改完 md 不用重启应用。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  EXPERTISE_IDS,
  expertiseFallback,
  normalizeExpertiseDisabled,
  type ExpertiseId,
  type ExpertiseMeta,
  type ExpertiseSource,
  type ExpertiseView
} from '../../shared/expertise';
import { parseFrontmatter } from './frontmatter';

/** 正文上限：system 轮次里塞几万字会把小模型的上下文挤没。 */
const MAX_BODY_CHARS = 20_000;

const EXPERT_FILE = 'EXPERT.md';
const SKILL_FILE = path.join('skills', 'engineering-design', 'SKILL.md');

export interface ExpertiseDocument {
  meta: ExpertiseMeta;
  body: string;
  source: ExpertiseSource;
  filePath: string;
  userPath: string;
  chars: number;
  /** 有值就表示这一项不注入，设置页会把它显示成红字原因。 */
  error?: string;
}

export interface ExpertiseState {
  expert: ExpertiseDocument;
  skill: ExpertiseDocument;
}

export interface LoadExpertiseOptions {
  /** 按优先级排列的内置目录，第一个存在的文件生效。 */
  builtinDirs: readonly string[];
  /** 用户可写目录（通常是 userData/expertise）。 */
  userDir: string;
}

function metaOf(id: ExpertiseId, fields: Record<string, string>): ExpertiseMeta {
  const base = expertiseFallback(id);
  return {
    ...base,
    title: fields.title?.trim() || base.title,
    description: fields.description?.trim() || base.description,
    trigger: fields.trigger?.trim() || base.trigger,
    doNotTrigger: (fields.do_not_trigger || fields.doNotTrigger || '').trim() || base.doNotTrigger,
    version: fields.version?.trim() || base.version
  };
}

function emptyDoc(id: ExpertiseId, userPath: string): ExpertiseDocument {
  return {
    meta: expertiseFallback(id),
    body: '',
    source: 'builtin',
    filePath: userPath,
    userPath,
    chars: 0,
    error: undefined
  };
}

function readDoc(id: ExpertiseId, rel: string, options: LoadExpertiseOptions): ExpertiseDocument {
  const userPath = path.join(options.userDir, rel);
  const candidates: Array<{ file: string; source: ExpertiseSource }> = [
    { file: userPath, source: 'user' },
    ...options.builtinDirs.map(dir => ({ file: path.join(dir, rel), source: 'builtin' as const }))
  ];

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate.file, 'utf8');
    } catch (error) {
      // 不存在就继续找下一个；其它读失败（权限等）也当作「这个候选不可用」，
      // 但内置目录全挂时下面的兜底会给出明确原因。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return {
        ...emptyDoc(id, userPath),
        filePath: candidate.file,
        source: candidate.source,
        error: `读不到文件：${(error as Error).message}`
      };
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      return {
        ...emptyDoc(id, userPath),
        filePath: candidate.file,
        source: candidate.source,
        error: '文件开头不是完整的 --- frontmatter（需要有 --- 开始与结束行）'
      };
    }
    if (!parsed.body.trim()) {
      return {
        ...emptyDoc(id, userPath),
        filePath: candidate.file,
        source: candidate.source,
        error: '正文是空的，没有内容可以注入'
      };
    }
    if (parsed.body.length > MAX_BODY_CHARS) {
      return {
        ...emptyDoc(id, userPath),
        filePath: candidate.file,
        source: candidate.source,
        chars: parsed.body.length,
        error: `正文 ${parsed.body.length} 字，超过 ${MAX_BODY_CHARS} 字上限，精简后再用`
      };
    }

    return {
      meta: metaOf(id, parsed.fields),
      body: parsed.body,
      source: candidate.source,
      filePath: candidate.file,
      userPath,
      chars: parsed.body.length
    };
  }

  return {
    ...emptyDoc(id, userPath),
    error: `没找到 ${rel}（内置目录与用户目录都没有这个文件）`
  };
}

export function loadExpertise(options: LoadExpertiseOptions): ExpertiseState {
  return {
    expert: readDoc('senior-developer', EXPERT_FILE, options),
    skill: readDoc('engineering-design', SKILL_FILE, options)
  };
}

export function docOf(state: ExpertiseState, id: ExpertiseId): ExpertiseDocument {
  return id === 'senior-developer' ? state.expert : state.skill;
}

/** 界面清单：一条专家、一条技能，带开关、来源与可替换路径。 */
export function describeExpertise(state: ExpertiseState, disabled: unknown): ExpertiseView[] {
  const set = new Set(normalizeExpertiseDisabled(disabled));
  return EXPERTISE_IDS.map(id => {
    const doc = docOf(state, id);
    return {
      ...doc.meta,
      enabled: !set.has(id),
      source: doc.source,
      filePath: doc.filePath,
      userPath: doc.userPath,
      chars: doc.chars,
      ...(doc.error ? { error: doc.error } : {})
    };
  });
}
