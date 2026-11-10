import React, { useMemo, useRef, useState } from 'react';
import type { TraceStep, TraceTurn } from '../../../shared/trace';

export interface TraceRange {
  start: number;
  end: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timeLabel(value: number): string {
  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 一轮的真实时间概览。
 *
 * 不是装饰性甘特图：横轴是墙上时间，条的左右来自 step.startedAt/endedAt；
 * 拖选区间会过滤下面的表格，滚轮缩放，右键复位。运行中的步只画到“现在”，
 * 不编结束时间；没有起止的旧记录直接不出条。
 */
export function TraceTimeline(props: {
  turn: TraceTurn;
  selected: string | null;
  range: TraceRange | null;
  onSelect: (key: string) => void;
  onRange: (range: TraceRange | null) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState<{ startX: number; currentX: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const steps = props.turn.steps.filter(step => step.startedAt !== null);
  const bounds = useMemo(() => {
    const starts = steps.map(step => step.startedAt).filter((value): value is number => value !== null);
    const ends = steps
      .map(step => step.endedAt ?? (step.status === 'running' ? Date.now() : step.startedAt))
      .filter((value): value is number => value !== null);
    const start = props.turn.startedAt ?? (starts.length > 0 ? Math.min(...starts) : null);
    const end = props.turn.endedAt ?? (ends.length > 0 ? Math.max(...ends) : null);
    if (start === null || end === null || end <= start) return null;
    return { start, end };
  }, [steps, props.turn.startedAt, props.turn.endedAt]);

  if (bounds === null || steps.length === 0) return null;

  const span = bounds.end - bounds.start;
  const viewSpan = span / zoom;
  const maxOffset = Math.max(0, 1 - 1 / zoom);
  const safeOffset = clamp(offset, 0, maxOffset);
  const viewStart = bounds.start + span * safeOffset;
  const viewEnd = viewStart + viewSpan;
  const percent = (value: number) => ((value - viewStart) / viewSpan) * 100;

  /**
   * 一条泳道 = 一个人 + 一个阶段。
   *
   * 只按 actorId 分会让第一轮回答和它后面的汇总共用一行：同一时间轴上出现
   * 两段不连续的条，看起来像「第一轮还没结束就又开始了一次」。汇总本来就是
   * 第一轮结束后的新条目，应该单独一行。
   */
  const GROUP_SUFFIX: Record<string, string> = {
    lead: '汇总',
    debate: '辩论',
    followup: '追加',
    synthesis: '综合',
    execute: '执行',
    prepare: '准备'
  };
  const lanes = new Map<string, { steps: TraceStep[]; label: string }>();
  for (const step of steps) {
    const key = `${step.actorId}::${step.group}`;
    const lane = lanes.get(key) ?? { steps: [], label: step.actorLabel };
    lane.steps.push(step);
    if (GROUP_SUFFIX[step.group]) lane.label = `${step.actorLabel} · ${GROUP_SUFFIX[step.group]}`;
    lanes.set(key, lane);
  }

  function timeAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return viewStart;
    return viewStart + clamp((clientX - rect.left) / rect.width, 0, 1) * viewSpan;
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const next = clamp(event.deltaY > 0 ? zoom / 1.25 : zoom * 1.25, 1, 16);
    setZoom(next);
    setOffset(current => clamp(current, 0, Math.max(0, 1 - 1 / next)));
  }

  function reset() {
    setZoom(1);
    setOffset(0);
    props.onRange(null);
  }

  return (
    <div
      className="trace-timeline"
      onWheel={handleWheel}
      onContextMenu={event => {
        event.preventDefault();
        reset();
      }}
      title="滚轮缩放 · 拖选区间过滤表格 · 右键复位"
    >
      <div className="trace-timeline-axis">
        {Array.from({ length: 5 }, (_, index) => {
          const at = viewStart + (viewSpan * index) / 4;
          return (
            <span key={index} style={{ left: `${(index / 4) * 100}%` }}>
              {timeLabel(at)}
            </span>
          );
        })}
      </div>

      {[...lanes.entries()].map(([laneKey, lane], laneIndex) => {
        const laneSteps = lane.steps;
        return (
        <div className="trace-timeline-lane" key={laneKey}>
          <span className="trace-timeline-name" title={laneKey}>
            {lane.label}
          </span>
          <div
            className="trace-timeline-track"
            ref={laneIndex === 0 ? trackRef : undefined}
            onPointerDown={event => {
              if (event.button !== 0) return;
              setDragging({ startX: event.clientX, currentX: event.clientX });
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              if (!dragging) return;
              setDragging({ ...dragging, currentX: event.clientX });
            }}
            onPointerUp={event => {
              if (!dragging) return;
              const start = timeAt(dragging.startX);
              const end = timeAt(event.clientX);
              setDragging(null);
              if (Math.abs(dragging.startX - event.clientX) < 4) {
                props.onRange(null);
                return;
              }
              props.onRange({ start: Math.min(start, end), end: Math.max(start, end) });
            }}
            onPointerCancel={() => setDragging(null)}
          >
            {laneSteps.map(step => {
              const start = step.startedAt ?? viewStart;
              const end =
                step.endedAt ??
                (step.status === 'running' ? Date.now() : start);
              const left = clamp(percent(start), 0, 100);
              const right = clamp(percent(Math.max(end, start + 1)), 0, 100);
              return (
                <button
                  type="button"
                  key={step.key}
                  className={`trace-timeline-bar s-${step.status}${props.selected === step.key ? ' is-selected' : ''}${step.status === 'running' ? ' is-running' : ''}`}
                  style={{ left: `${left}%`, width: `${Math.max(0.6, right - left)}%` }}
                  title={`${step.actorLabel} · ${step.stage} · ${timeLabel(start)} → ${step.endedAt !== null ? timeLabel(step.endedAt) : '运行中'}`}
                  onClick={event => {
                    event.stopPropagation();
                    props.onSelect(step.key);
                  }}
                />
              );
            })}
            {dragging && (() => {
              const rect = trackRef.current?.getBoundingClientRect();
              if (!rect) return null;
              const left = clamp(Math.min(dragging.startX, dragging.currentX) - rect.left, 0, rect.width);
              const width = clamp(Math.abs(dragging.currentX - dragging.startX), 0, rect.width - left);
              return (
                <span
                  className="trace-timeline-brush"
                  style={{
                    left: `${(left / rect.width) * 100}%`,
                    width: `${(width / rect.width) * 100}%`
                  }}
                />
              );
            })()}
          </div>
        </div>
        );
      })}

      {props.range && (
        <div className="trace-timeline-range">
          已选 {timeLabel(props.range.start)} → {timeLabel(props.range.end)}
          <button type="button" className="btn ghost" onClick={() => props.onRange(null)}>清除</button>
        </div>
      )}
    </div>
  );
}
