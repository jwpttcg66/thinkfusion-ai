#!/usr/bin/env node
/**
 * 终端事件回放 / 审计完整性检查。
 *
 * 用法：
 *   node scripts/replay-terminal.mjs <sessionId 或 .jsonl 路径> [--markers] [--verify]
 *   node scripts/replay-terminal.mjs --list
 *
 * 默认把 stdout/stderr 事件按 sequence 原样写到对应流；加 --markers 才把
 * stdin / resize / cancel / exit / 审计标记打到 stderr——回放终端画面时不该
 * 被这些标记污染。--verify 只做校验不重放，给自动化与发布 Gate 用。
 *
 * 校验三件审核里点名的事：sequence 单调递增、resize 事件保留、
 * 写入失败/截断被明确标记（而不是静默当成完整记录）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AUDIT_DIR =
  process.env.TF_TERMINAL_AUDIT_DIR ??
  path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai', 'terminal-records');

const OUTPUT_TYPES = new Set(['stdout', 'stderr']);
const STRUCTURE_TYPES = new Set([
  'session-start', 'stdin', 'resize', 'connection', 'cancel',
  'exit', 'session-end', 'audit-error', 'audit-truncated'
]);

function parseArgs(argv) {
  const flags = new Set(argv.filter(item => item.startsWith('--')));
  const target = argv.find(item => !item.startsWith('--'));
  return { target, markers: flags.has('--markers'), verify: flags.has('--verify'), list: flags.has('--list') };
}

function fileOf(target) {
  if (!target) return null;
  if (target.endsWith('.jsonl') && fs.existsSync(target)) return target;
  const safe = path.basename(target).replace(/[^A-Za-z0-9._-]/g, '_');
  const inDir = path.join(AUDIT_DIR, `${safe}.jsonl`);
  if (fs.existsSync(inDir)) return inDir;
  return fs.existsSync(target) ? target : null;
}

function readEvents(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const events = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.sequence !== 'number' || typeof parsed.type !== 'string') {
        broken += 1;
        continue;
      }
      events.push(parsed);
    } catch {
      broken += 1;
    }
  }
  return { events, broken };
}

/** 校验：返回问题清单，空数组表示通过。 */
export function verifyEvents(events, broken = 0) {
  const problems = [];
  if (broken > 0) problems.push(`${broken} 行不是合法事件（崩溃留下的半行）`);
  if (events.length === 0) return [...problems, '记录为空'];
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].sequence <= events[i - 1].sequence) {
      problems.push(`sequence 非单调递增：第 ${i} 条 ${events[i].sequence} <= ${events[i - 1].sequence}`);
      break;
    }
  }
  const types = events.map(item => item.type);
  if (!types.includes('session-start')) problems.push('缺少 session-start');
  if (!types.includes('session-end')) problems.push('缺少 session-end（进程可能还在跑，或崩溃过）');
  const unknown = types.filter(type => !OUTPUT_TYPES.has(type) && !STRUCTURE_TYPES.has(type));
  if (unknown.length > 0) problems.push(`存在未知事件类型：${[...new Set(unknown)].join(', ')}`);
  const dropped = events.filter(item => item.dropped === true).length;
  if (dropped > 0) problems.push(`${dropped} 条事件的正文被丢弃（dropped=true，回放不完整）`);
  if (events.some(item => item.type === 'audit-error')) problems.push('记录里标记过写入失败，审计不完整');
  if (events.some(item => item.type === 'audit-truncated')) problems.push('记录超过单文件上限，正文不再落盘');
  // 主进程在 before-quit 补的尾不是 Runtime 观测到的退出：明确标不完整，
  // 否则「有 session-end」会被误读成「这份记录完整」。
  const endEvent = events.find(item => item.type === 'session-end');
  if (endEvent) {
    try {
      const meta = JSON.parse(endEvent.data ?? '{}');
      if (meta.auditIncomplete === true) {
        problems.push('会话收尾由主进程补记（auditIncomplete=true）：退出码/信号未知，这份记录不完整');
      }
    } catch {
      // 老记录没有 data 字段，不据此下结论。
    }
  }
  return problems;
}

function markerFor(event) {
  switch (event.type) {
    case 'resize': return `[RESIZE ${event.cols ?? '?'}x${event.rows ?? '?'}]\n`;
    case 'stdin': return `[STDIN ${(event.data ?? '').length} chars]\n`;
    case 'connection': return `[CONNECTION ${event.data ?? ''}]\n`;
    case 'cancel': return `[CANCEL ${event.reason ?? event.signal ?? ''}]\n`;
    case 'exit': return `[EXIT code=${String(event.exitCode ?? '?')} state=${event.state ?? ''}]\n`;
    case 'session-start': return `[SESSION-START ${event.data ?? ''}]\n`;
    case 'session-end': return `[SESSION-END ${event.data ?? ''}]\n`;
    case 'audit-error': return `[AUDIT-ERROR ${event.reason ?? ''}]\n`;
    case 'audit-truncated': return `[AUDIT-TRUNCATED ${event.reason ?? ''}]\n`;
    default: return '';
  }
}

function replay(events, markers) {
  for (const event of events) {
    if (event.type === 'stdout') {
      process.stdout.write(event.data ?? '');
    } else if (event.type === 'stderr') {
      process.stderr.write(event.data ?? '');
    } else if (markers) {
      process.stderr.write(markerFor(event));
    }
  }
}

function main() {
  const { target, markers, verify, list } = parseArgs(process.argv.slice(2));
  if (list || !target) {
    if (!fs.existsSync(AUDIT_DIR)) {
      console.log(`审计目录不存在：${AUDIT_DIR}`);
      return;
    }
    // app-exit.jsonl 是全局退出记录（没有 sequence），不是会话事件流；
    // 列进 --list 会被误报成「2 行不是合法事件」。
    const all = fs.readdirSync(AUDIT_DIR).filter(name => name.endsWith('.jsonl'));
    const files = all.filter(name => name !== 'app-exit.jsonl');
    if (files.length === 0) {
      console.log(`审计目录没有会话记录：${AUDIT_DIR}`);
      return;
    }
    for (const name of files.sort()) {
      const file = path.join(AUDIT_DIR, name);
      const { events, broken } = readEvents(file);
      const resizes = events.filter(item => item.type === 'resize').length;
      const problems = verifyEvents(events, broken);
      console.log(
        `${name.padEnd(42)} ${String(events.length).padStart(6)} 事件  resize=${String(resizes).padStart(3)}  ` +
          `${fs.statSync(file).size} 字节  ${problems.length === 0 ? '完整' : `注意：${problems[0]}`}`
      );
    }
    return;
  }

  const file = fileOf(target);
  if (!file) {
    console.error(`找不到记录：${target}（审计目录 ${AUDIT_DIR}）`);
    process.exitCode = 2;
    return;
  }
  const { events, broken } = readEvents(file);
  // 文件本身按追加顺序写，仍排一次：读到的可能是被外部拼接/修复过的记录。
  events.sort((left, right) => left.sequence - right.sequence);

  if (verify) {
    const problems = verifyEvents(events, broken);
    console.log(`文件：${file}`);
    console.log(`事件：${events.length}，resize：${events.filter(item => item.type === 'resize').length}`);
    if (problems.length === 0) {
      console.log('校验通过：sequence 单调递增、结构完整、resize 保留、无写入失败标记');
    } else {
      for (const problem of problems) console.log(`- ${problem}`);
      console.log('校验未通过：这份记录不能当作完整审计');
      process.exitCode = 1;
    }
    return;
  }
  replay(events, markers);
}

// 作为模块被 node --test 引用时不自动执行。
if (import.meta.url === `file://${process.argv[1]}`) main();
