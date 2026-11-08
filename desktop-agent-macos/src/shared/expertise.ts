/**
 * 专家与技能：给界面看的那份清单契约。
 *
 * 刻意不进 CAPABILITY_CATALOG——那边登记的是「会执行、要权限、能被停用拦截」
 * 的能力插件，宿主按 id 分派。专家与技能是**内容**：只往本地/云端模型的
 * system 轮次里添几行字，不执行动作、不占成员名额、不是辩手。
 *
 * 形状照 WorkBuddy：一个专家是常驻人设（agents 下的 md），技能是按场景加载的
 * 工作流（skills 下的 SKILL.md）。技能没有自己的 agent；在 ThinkFusion 里
 * 「agent」已经被参与讨论的成员/通道占用了，更不能给技能配一个。
 */

export type ExpertiseId = 'senior-developer' | 'engineering-design';
export type ExpertiseKind = 'expert' | 'skill';
export type ExpertiseSource = 'builtin' | 'user';

/** 两个内置条目的登记信息。文件里读不到的字段用它兜底。 */
export interface ExpertiseMeta {
  id: ExpertiseId;
  kind: ExpertiseKind;
  title: string;
  /** frontmatter 的 description；替换文件后跟着变。 */
  description: string;
  trigger: string;
  doNotTrigger: string;
  version: string;
}

export interface ExpertiseView extends ExpertiseMeta {
  enabled: boolean;
  /** 实际生效的是内置文件还是用户替换的文件。 */
  source: ExpertiseSource;
  /** 实际生效的文件绝对路径。 */
  filePath: string;
  /** 用户把同名文件放在这里就能覆盖内置版本；文件不必先存在。 */
  userPath: string;
  /** 正文字符数。0 表示没读到内容，这一项不会生效。 */
  chars: number;
  /** 文件缺失或格式坏了的说明；有值时这一项不注入。 */
  error?: string;
}

export const EXPERTISE_IDS: readonly ExpertiseId[] = [
  'senior-developer',
  'engineering-design'
];

const FALLBACK: Record<ExpertiseId, ExpertiseMeta> = {
  'senior-developer': {
    id: 'senior-developer',
    kind: 'expert',
    title: '高级开发工程师',
    description: '10 年以上全栈经验，以工程纪律交付可运行的高质量代码',
    trigger: '工程空间常驻',
    doNotTrigger: '知识空间与网页通道一律不加载',
    version: 'builtin'
  },
  'engineering-design': {
    id: 'engineering-design',
    kind: 'skill',
    title: '工程设计与实施',
    description: '设计、实现与改造类任务的规划、增量验证和交付工作流',
    trigger: '设计、架构、实现、重构、迁移、选型、集成、加功能、修 bug',
    doNotTrigger: '多少行、多少条、统计、查事实、读文件、定位报错',
    version: 'builtin'
  }
};

export function expertiseFallback(id: ExpertiseId): ExpertiseMeta {
  return { ...FALLBACK[id] };
}

export function isExpertiseId(value: unknown): value is ExpertiseId {
  return typeof value === 'string' && (EXPERTISE_IDS as readonly string[]).includes(value);
}

/** 开关文件只记「关掉的」，和 capabilities.json 一个道理：新增条目默认开着。 */
export function normalizeExpertiseDisabled(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isExpertiseId))];
}

export const EXPERTISE_KIND_LABELS: Record<ExpertiseKind, string> = {
  expert: '专家',
  skill: '技能'
};
