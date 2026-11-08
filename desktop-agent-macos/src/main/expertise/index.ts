/** 专家与技能：文件加载、场景判定、system 拼装、开关持久化。 */
export { parseFrontmatter } from './frontmatter';
export { loadExpertise, describeExpertise, docOf } from './loader';
export type { ExpertiseState, ExpertiseDocument, LoadExpertiseOptions } from './loader';
export { shouldLoadEngineeringSkill } from './trigger';
export type { SkillTrigger } from './trigger';
export { buildEngineeringExpertise } from './system';
export type { BuildExpertiseInput, BuiltExpertise } from './system';
export { ExpertiseStore } from './store';
