import React from 'react';
import type { PermissionPreset, PlanPreview as PlanPreviewType } from '../../../shared/contracts';

const TOOL_LABEL: Record<string, string> = {
  'fs.list': '列目录',
  'fs.readFile': '读文件',
  'fs.mkdir': '建目录',
  'fs.writeFile': '写文件',
  'fs.tree': '看结构',
  'fs.search': '搜代码',
  'fs.find': '找文件',
  'test.run': '跑测试',
  'shell.run': '执行命令',
  'screen.capture': '截屏',
  'app.open': '打开应用'
};

function isWrite(tool: string) {
  return tool === 'fs.writeFile' || tool === 'fs.mkdir';
}

/** 会动到工作区之外（系统命令、屏幕、进程）的步骤。 */
function isSystem(tool: string) {
  return tool === 'shell.run' || tool === 'screen.capture' || tool === 'app.open' || tool === 'test.run';
}

function argSummary(args: Record<string, unknown>): string {
  const command = typeof args.command === 'string' ? args.command : '';
  if (command) return command;
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern) return `${pattern}${typeof args.path === 'string' ? `（在 ${args.path}）` : ''}`;
  const app = typeof args.app === 'string' ? args.app : '';
  if (app) return app;
  const path = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (content) return `${path}（写入 ${content.length} 字符）`;
  if (path) return path;
  const region = args.region as { width?: number; height?: number } | undefined;
  if (region?.width) return `区域 ${region.width}×${region.height ?? '?'}`;
  return '全屏';
}

export function PlanPreview(props: {
  plan: PlanPreviewType;
  permission: PermissionPreset;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const writes = props.plan.steps.filter(step => isWrite(step.tool));
  const systems = props.plan.steps.filter(step => isSystem(step.tool));

  return (
    <section className="card plan">
      <div className="plan-head">
        <h2>{props.plan.title}</h2>
        <span className="chip">{props.plan.steps.length} 步</span>
      </div>
      {props.plan.description && <p className="plan-desc">{props.plan.description}</p>}

      <ol className="steps">
        {props.plan.steps.map(step => (
          <li key={step.id} className={isWrite(step.tool) ? 'write' : isSystem(step.tool) ? 'system' : ''}>
            <div className="step-line">
              <code className="tool">{TOOL_LABEL[step.tool] ?? step.tool}</code>
              <span className="step-path">{argSummary(step.args)}</span>
            </div>
            {step.description && <div className="step-desc">{step.description}</div>}
          </li>
        ))}
      </ol>

      <div className="plan-facts">
        <div>
          <span className="muted">完成条件</span>
          <p>{props.plan.completion}</p>
        </div>
        <div>
          <span className="muted">当前权限</span>
          <p>{props.permission === 'read-only' ? '仅可查看' : props.permission === 'workspace-write' ? '工作区内修改' : '完全权限'}</p>
        </div>
      </div>

      {writes.length > 0 && (
        <div className="notice">
          计划包含 {writes.length} 个写入操作，落盘前会再次校验路径与内容摘要；覆盖已有文件必须带上一版的内容指纹，对不上就拒绝。
        </div>
      )}

      {systems.length > 0 && (
        <div className="notice">
          计划包含 {systems.length} 个系统操作（命令 / 截屏 / 启动应用），会在这台机器上真实执行，
          而不只是给建议。确认前请看清每一步的命令与目标。
        </div>
      )}

      {props.plan.debate && (
        <div className="plan-debate">
          <div className="plan-debate-head">
            <strong>方案评审</strong>
            <span className="muted">
              {props.plan.debate.status === 'skipped'
                ? '未辩论'
                : `${props.plan.debate.status === 'completed' ? '已辩完' : '没辩成（成员超时或忙碌）'}${props.plan.debate.participants.length > 0 ? ` · ${props.plan.debate.participants.join('、')}` : ''}`}
            </span>
          </div>
          {props.plan.debate.skippedReason && (
            <p className="plan-debate-skip">{props.plan.debate.skippedReason}</p>
          )}
          {props.plan.debate.topics.length > 0 && (
            <p className="plan-debate-topics">辩题：{props.plan.debate.topics.join('；')}</p>
          )}
          {props.plan.debate.summary && (
            <pre className="plan-debate-summary">{props.plan.debate.summary}</pre>
          )}
          <p className="muted small">辩论只给判断，不改变执行权限；确认之前不会动任何文件。</p>
        </div>
      )}

      <div className="plan-actions">
        <button className="btn secondary" type="button" disabled={props.busy} onClick={props.onReject}>
          拒绝计划
        </button>
        <button className="btn" type="button" disabled={props.busy} onClick={props.onApprove}>
          {props.busy ? '执行中…' : '确认并执行'}
        </button>
      </div>
    </section>
  );
}
