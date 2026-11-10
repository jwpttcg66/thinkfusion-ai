import React, { useEffect, useRef } from 'react';
import type { AgentEvent } from '../../../shared/contracts';

interface Line {
  key: string;
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'error' | 'muted';
}

export function formatEvent(event: AgentEvent, index: number): Line | null {
  const key = `${event.at}-${index}`;
  switch (event.type) {
    case 'round.started':
      return { key, text: `第 ${event.roundNumber} 轮 · ${roundType(event.inputType)} 已发送`, tone: 'muted' };
    case 'round.answer':
      return { key, text: `收到回答（${event.text.length} 字符）`, tone: 'info' };
    case 'plan.ready':
      return { key, text: `计划已就绪：${event.plan.title}（${event.plan.steps.length} 步），等待确认`, tone: 'info' };
    case 'plan.invalid':
      return { key, text: `计划被拒绝：${event.error}`, tone: 'error' };
    case 'clarification.required':
      // "模型", not a site name: which page is driving the plan is a setting
      // (`planningSource`), and an event carries no site id to look a name up
      // by. A hardcoded name here is simply wrong once the setting changes.
      return { key, text: `模型需要澄清：${event.questions.join(' / ')}`, tone: 'warn' };
    case 'step.started':
      return { key, text: `执行 ${toolLabel(event.tool)}`, tone: 'muted' };
    case 'step.approval':
      return {
        key,
        text: `等待确认第 ${event.index}/${event.total} 步：${toolLabel(event.tool)}${event.risk === 'danger' ? '（高危）' : ''}`,
        tone: 'warn'
      };
    case 'step.approval-resolved':
      return {
        key,
        text: event.approved ? `已放行：${event.reason ?? '用户批准'}` : `已拦下：${event.reason ?? '用户拒绝'}`,
        tone: event.approved ? 'ok' : 'warn'
      };
    case 'step.completed':
      // 「完成 shell.run」看不出到底跑了什么、成功没有。退出码、截图尺寸、
      // 进程 pid 都是执行结果的一部分，日志里必须能直接读到。
      return { key, text: `完成 ${toolLabel(event.tool)}${stepSummary(event.tool, event.result)}`, tone: 'ok' };
    case 'step.failed':
      return { key, text: `失败 ${toolLabel(event.tool)}：${event.error}`, tone: 'error' };
    case 'report.ready':
      return {
        key,
        text: `执行报告：${event.report.status}（成功 ${event.report.results.filter(r => r.status === 'completed').length} 步${event.report.evidence ? ` · 证据 ${event.report.evidence.refs.length} 条` : ''}）`,
        tone: event.report.status === 'completed' ? 'ok' : 'warn'
      };
    case 'review.ready':
      return {
        key,
        text: `独立评审（${event.backend === 'rules' ? '规则版' : event.reviewer}）：${event.needsFix ? '需修复' : '通过'} · ${event.verdict.slice(0, 120)}`,
        tone: event.needsFix ? 'warn' : 'ok'
      };
    case 'plan.debated':
      // 「没辩」也要出现在日志里：审批的人需要知道这份计划有没有被评审过。
      return event.debate.status === 'skipped'
        ? { key, text: `方案评审未进行：${event.debate.skippedReason ?? '没有可用成员'}`, tone: 'muted' }
        : {
            key,
            text: `方案评审已辩完（${event.debate.participants.join('、')}）：${event.debate.topics.length} 个辩题`,
            tone: 'ok'
          };
    case 'report.sent':
      return { key, text: '执行报告已回传给模型', tone: 'muted' };
    case 'task.completed':
      return { key, text: `任务完成${event.summary ? `：${event.summary}` : ''}`, tone: 'ok' };
    case 'task.failed':
      return { key, text: `任务失败：${event.error}`, tone: 'error' };
    case 'task.cancelled':
      return { key, text: '任务已取消', tone: 'warn' };
    case 'log':
      return { key, text: event.message, tone: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'muted' };
    case 'task.updated':
      return null;
    default:
      return null;
  }
}

function roundType(inputType: string) {
  if (inputType === 'user_prompt') return '任务';
  if (inputType === 'execution_report') return '执行报告';
  if (inputType === 'plan_repair') return '计划修正';
  return '澄清回答';
}

const TOOL_NAME: Record<string, string> = {
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

export function toolLabel(tool: string) {
  return TOOL_NAME[tool] ?? tool;
}

function stepSummary(tool: string, result: unknown): string {
  const data = result as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return '';
  if (tool === 'test.run' || tool === 'shell.run') {
    if (data.job && typeof data.job === 'object') {
      const job = data.job as Record<string, unknown>;
      return ` · 后台 ${String(job.id)}（pid ${String(job.pid)}）`;
    }
    const timeout = data.timedOut ? '（超时）' : '';
    return ` · 退出码 ${String(data.exitCode)}${timeout} · ${String(data.durationMs)}ms`;
  }
  if (tool === 'job.list') {
    const jobs = data.jobs;
    return ` · ${Array.isArray(jobs) ? jobs.length : 0} 个作业`;
  }
  if (tool === 'job.output') return ` · ${String(data.bytes)} 字节${data.truncated ? '（已截断）' : ''}`;
  if (tool === 'job.kill') return ` · 信号 ${String(data.signal)} · ${data.stillRunning ? '仍在运行' : '已结束'}`;
  if (tool === 'fs.edit') return ` · 替换 ${String(data.replaced)} 处 · ${String(data.bytes)} 字节`;
  if (tool === 'fs.remove') return data.trashed ? ` · 已移入废纸篓 ${String(data.trashPath)}` : ' · 已永久删除';
  if (tool === 'fs.move' || tool === 'fs.copy') return ` · → ${String(data.to)}`;
  if (tool === 'fs.stat') return ` · ${String(data.type)} · ${String(data.bytes)} 字节`;
  if (tool === 'fs.readImage') return ` · ${String(data.width)}×${String(data.height)} · ${String(data.mime)}`;
  if (tool === 'clipboard.read') return ` · ${String(data.chars)} 字符`;
  if (tool === 'clipboard.write') return ` · 写入 ${String(data.written)} 字符`;
  if (tool === 'notify') return ` · ${String(data.title)}`;
  if (tool === 'system.info') {
    const osInfo = data.os as Record<string, unknown> | undefined;
    const memory = data.memory as Record<string, unknown> | undefined;
    return osInfo
      ? ` · ${String(osInfo.type)} ${String(osInfo.release)} · 内存 ${String(memory?.totalGb ?? '?')}GB`
      : '';
  }
  if (tool === 'process.list') return ` · 匹配 ${String(data.matched)}/${String(data.total)}`;
  if (tool === 'process.kill') return ` · pid ${String(data.pid)} · ${data.stillRunning ? '仍在运行' : '已结束'}`;
  if (tool === 'web.fetch') return ` · HTTP ${String(data.status)} · ${String(data.bytes)} 字节`;
  if (tool === 'web.search') {
    const count = Array.isArray(data.results) ? data.results.length : 0;
    // provider=ddg 说明这是免凭据摘要，不是完整结果列表。日志里要能分辨，
    // 否则「搜到 2 条」会一直被当成「搜到了」。
    const via = data.provider === 'ddg' ? '（免凭据摘要）' : data.provider === 'none' ? '（无结果）' : `（${String(data.provider)}）`;
    return ` · ${count} 条${via}`;
  }
  if (tool === 'code.run') {
    const timeout = data.timedOut ? '（超时）' : '';
    return ` · ${String(data.language)} · 退出码 ${String(data.exitCode)}${timeout} · ${String(data.durationMs)}ms`;
  }
  if (tool === 'screen.capture') return ` · ${String(data.width)}×${String(data.height)} · ${String(data.path)}`;
  if (tool === 'app.open') {
    if (data.running === true) return ` · ${String(data.app ?? data.path)} · 已启动（pid ${String(data.pid)}）`;
    if (data.running === false) return ` · ${String(data.app ?? data.path)} · 进程未检测到`;
    return ` · ${String(data.path)}`;
  }
  if (tool === 'fs.find' || tool === 'fs.search') {
    const matches = Array.isArray(data.matches) ? data.matches.length : 0;
    return ` · ${matches} 个命中`;
  }
  if (tool === 'fs.readFile') return ` · ${String(data.bytes)} 字节`;
  if (typeof data.path === 'string') return ` · ${data.path}`;
  return '';
}

export function ExecutionLog(props: { events: AgentEvent[] }) {
  // Oldest first: a transcript reads downwards, and the line you want is the
  // one that just happened — at the bottom, where your eye already is.
  const lines = props.events.map((event, index) => formatEvent(event, index)).filter((line): line is Line => line !== null);

  // Follow the tail. Without this the newest line lands below the fold of a
  // fixed-height box, which is the same problem as reversing the order.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [lines.length]);

  return (
    <section className="card log">
      <div className="row">
        <h2>执行日志</h2>
        <span className="muted">{lines.length} 条</span>
      </div>
      {lines.length === 0 ? (
        <p className="muted">暂无事件。</p>
      ) : (
        <div className="log-lines" ref={listRef}>
          {lines.map(line => (
            <div key={line.key} className={`log-line t-${line.tone}`}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
