import path from 'node:path';
import fs from 'node:fs/promises';
import { READ_ONLY_TOOLS, type TaskGrant, type PlanStep } from '../shared/contracts';

type ToolName = PlanStep['tool'];

const MAX_PATH_LENGTH = 500;

function validateInputPath(value: string) {
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || value.includes('\0')) {
    throw new Error('路径无效或超过长度限制');
  }
  if (!value.trim()) throw new Error('路径不能为空');
}

async function assertNoSymlinkComponents(root: string, target: string, allowMissingLeaf: boolean) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('路径越过授权根目录');
  }
  let cursor = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('不允许通过符号链接访问工作区文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf) break;
      throw error;
    }
  }
}

export async function resolveGrantedPath(grant: TaskGrant, inputPath: string, allowMissingLeaf = true): Promise<string> {
  if (Date.now() > grant.expiresAt) throw new Error('任务授权已过期');
  validateInputPath(inputPath);

  if (grant.permissionPreset === 'danger-full-access') {
    // Full access removes the app's workspace boundary, not macOS TCC or POSIX user permissions.
    return path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(grant.rootDir, inputPath));
  }

  if (path.isAbsolute(inputPath)) throw new Error('只允许使用授权目录内的相对路径');
  const parts = inputPath === '.' ? [] : inputPath.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..')) {
    if (inputPath !== '.' && inputPath !== '') throw new Error('路径包含非法片段');
  }

  const root = await fs.realpath(grant.rootDir);
  const target = path.resolve(root, ...parts.filter(Boolean));
  await assertNoSymlinkComponents(root, target, allowMissingLeaf);
  return target;
}

export function assertGrant(grant: TaskGrant, tool: ToolName, stepCount: number) {
  if (!grant || !grant.taskId || !grant.rootDir || !Array.isArray(grant.allowedTools)) throw new Error('授权凭据结构无效');
  if (!grant.allowedTools.includes(tool)) throw new Error(`未授权工具：${tool}`);
  if (grant.permissionPreset === 'read-only' && !(READ_ONLY_TOOLS as readonly ToolName[]).includes(tool)) {
    throw new Error('当前权限为“仅可查看”，禁止文件修改与命令执行');
  }
  // test.run 会跑构建脚本、写临时产物，本质上是有副作用的操作。
  // 即便有人手工塞进 allowedTools，也不能在 read-only 下放行。
  if (tool === 'test.run' && grant.permissionPreset === 'read-only') {
    throw new Error('当前权限为“仅可查看”，禁止执行测试命令');
  }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(grant.permissionPreset)) throw new Error('未知权限模式');
  if (stepCount < 1 || stepCount > grant.maxSteps || stepCount > 30) throw new Error('步骤数超过授权上限');
  if (!Number.isFinite(grant.expiresAt) || Date.now() > grant.expiresAt) throw new Error('任务授权已过期');
}
