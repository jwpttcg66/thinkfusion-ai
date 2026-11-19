/** P6-06：版本/数据回滚计划。 */
export interface RollbackPlan {
  appVersion: string;
  dataSchema: number;
  steps: string[];
  preservesData: boolean;
}

export function planRollback(input: {
  fromVersion: string;
  toVersion: string;
  fromSchema: number;
  toSchema: number;
  backupPath?: string;
}): RollbackPlan {
  const steps = [
    `安装 ${input.toVersion}`,
    ...(input.backupPath ? [`恢复备份：${input.backupPath}`] : ['确认数据可被旧版本读取']),
    '启动并检查会话/知识/证据可读'
  ];
  return {
    appVersion: input.toVersion,
    dataSchema: input.toSchema,
    steps,
    preservesData: input.fromSchema <= input.toSchema
  };
}
