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
  'fs.stat': '看属性',
  'fs.edit': '改文件',
  'fs.remove': '删除',
  'fs.move': '移动',
  'fs.copy': '复制',
  'fs.readImage': '读图片',
  'test.run': '跑测试',
  'shell.run': '执行命令',
  'job.list': '列作业',
  'job.output': '读作业输出',
  'job.kill': '停作业',
  'screen.capture': '截屏',
  'app.open': '打开应用',
  'computer.capabilities': '桌面能力',
  'computer.windows': '桌面窗口',
  'computer.screenshot': '桌面截图',
  'computer.ax.tree': '控件树',
  'computer.ax.find': '查找控件',
  'computer.click': '点击',
  'computer.type': '输入',
  'computer.keypress': '按键',
  'computer.scroll': '滚动',
  'computer.drag': '拖动',
  'computer.focus': '聚焦窗口',
  'computer.verify': '核对桌面',
  'computer.stop': '停止桌面操作',
  'clipboard.read': '读剪贴板',
  'clipboard.write': '写剪贴板',
  notify: '发通知',
  'system.info': '系统信息',
  'process.list': '列进程',
  'process.kill': '结束进程',
  'web.fetch': '抓网页',
  'web.search': '联网搜索',
  'code.run': '跑代码'
};

function isWrite(tool: string) {
  return tool === 'fs.writeFile' || tool === 'fs.mkdir' || tool === 'fs.edit' ||
    tool === 'fs.remove' || tool === 'fs.move' || tool === 'fs.copy';
}

/** 会动到工作区之外（系统命令、屏幕、进程、剪贴板、网络、代码执行）的步骤。 */
function isSystem(tool: string) {
  return tool === 'shell.run' || tool === 'test.run' || tool === 'screen.capture' ||
    tool === 'app.open' || tool === 'job.kill' || tool === 'process.kill' ||
    tool === 'clipboard.write' || tool === 'notify' || tool === 'web.fetch' ||
    tool === 'web.search' || tool === 'code.run' || tool.startsWith('computer.');
}

function argSummary(args: Record<string, unknown>): string {
  const command = typeof args.command === 'string' ? args.command : '';
  if (command) return command;
  const query = typeof args.query === 'string' ? args.query : '';
  if (query) return `${query}${typeof args.site === 'string' ? `（限 ${args.site}）` : ''}`;
  const code = typeof args.code === 'string' ? args.code : '';
  if (code) {
    const lines = code.split('\n').length;
    return `${String(args.language ?? '')} · ${lines} 行`;
  }
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern) return `${pattern}${typeof args.path === 'string' ? `（在 ${args.path}）` : ''}`;
  const from = typeof args.from === 'string' ? args.from : '';
  const to = typeof args.to === 'string' ? args.to : '';
  if (from && to) return `${from} → ${to}`;
  const url = typeof args.url === 'string' ? args.url : '';
  if (url) return url;
  const app = typeof args.app === 'string' ? args.app : '';
  if (app) return app;
  const oldString = typeof args.oldString === 'string' ? args.oldString : '';
  if (oldString) return `${typeof args.path === 'string' ? args.path : ''}（替换 ${oldString.length} 字符）`;
  const path = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (content) return `${path}（写入 ${content.length} 字符）`;
  if (path) return path;
  if (typeof args.pid === 'number') return `pid ${args.pid}`;
  if (typeof args.id === 'string') return args.id;
  if (typeof args.text === 'string') return `${args.text.length} 字符`;
  if (typeof args.title === 'string') return args.title;
  const region = args.region as { width?: number; height?: number } | undefined;
  if (region?.width) return `区域 ${region.width}×${region.height ?? '?'}`;
  if (typeof args.scope === 'string') return args.scope;
  if (typeof args.filter === 'string') return `过滤：${args.filter}`;
  return '';
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

      {(props.plan.warnings ?? []).length > 0 && (
        <div className="notice warn">
          {/* 原来这里固定念一句「计划缺少判据：…」再拼上整条列表。可 warnings 里不止判据：
              分解方式是归纳出来的、工作流要人工批准、步骤带了执行器不用的说明字段
              （orchestrator.ts 的 toPreview + describeIgnoredAnnotations），套这个前缀就等于
              对着一份判据齐全的计划说它缺判据。每条本来就自带后果（判据缺失那句会自己说
              「执行后不会标已验证」），这里只逐条念原文，不再替它们下结论。 */}
          {(props.plan.warnings ?? []).map((line, index) => <p key={index}>{line}</p>)}
        </div>
      )}

      <ol className="steps">
        {props.plan.steps.map(step => (
          <li key={step.id} className={isWrite(step.tool) ? 'write' : isSystem(step.tool) ? 'system' : ''}>
            <div className="step-line">
              <code className="tool">{TOOL_LABEL[step.tool] ?? step.tool}</code>
              <span className="step-path">{argSummary(step.args) || (step.tool === 'screen.capture' ? '全屏' : '')}</span>
            </div>
            {step.description && <div className="step-desc">{step.description}</div>}
          </li>
        ))}
      </ol>

      <div className="plan-facts">
        <div>
          <span className="muted">执行目标</span>
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
                : [
                    props.plan.debate.status === 'completed' ? '已辩完' : '没辩成（成员超时或忙碌）',
                    // 只有一个成员时是自辩：同一成员分饰质疑与修正，不是多方独立意见，
                    // 必须写出来，否则读的人会以为这份计划被交叉审过。
                    props.plan.debate.participants.length === 1 ? '单模型自辩' : null,
                    props.plan.debate.participants.length > 0 ? props.plan.debate.participants.join('、') : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </div>
          {props.plan.debate.skippedReason && (
            <p className="plan-debate-skip">{props.plan.debate.skippedReason}</p>
          )}
          {props.plan.debate.roundsReason && (
            <p className="muted small">
              评审 {props.plan.debate.rounds ?? '?'} 轮 · {props.plan.debate.roundsReason}
            </p>
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
