import type { WorkBreakdownView } from '../../../shared/task-decomposition';

const STATUS_LABEL: Record<WorkBreakdownView['tasks'][number]['status'], string> = {
  pending: '待执行',
  ready: '就绪',
  running: '执行中',
  blocked: '阻塞',
  reviewing: '审核中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消'
};

function headLabel(status: WorkBreakdownView['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'blocked') return '已阻塞';
  if (status === 'failed') return '有失败';
  if (status === 'running') return '执行中';
  return '待启动';
}

export function WorkBreakdownPanel(props: {
  breakdown: WorkBreakdownView;
  onSelectTask?: (workTaskId: string) => void;
}) {
  const { breakdown, onSelectTask } = props;
  if (breakdown.source === 'empty' || breakdown.summary.total === 0) return null;

  return (
    <section className="work-breakdown" aria-label="任务分解进度">
      <header className="work-breakdown-head">
        <div>
          <strong>{breakdown.title}</strong>
          <span className="muted"> · {headLabel(breakdown.status)}</span>
        </div>
        <code className="work-breakdown-score">
          {String(breakdown.summary.completed)} / {String(breakdown.summary.total)}
        </code>
      </header>
      <ol className="work-breakdown-list">
        {breakdown.tasks.map(task => {
          const current = task.workTaskId === breakdown.currentTaskId;
          return (
            <li
              key={task.workTaskId}
              className={`work-breakdown-item is-${task.status}${current ? ' is-current' : ''}`}
            >
              <button
                type="button"
                className="work-breakdown-row"
                onClick={() => onSelectTask?.(task.workTaskId)}
              >
                <span className="work-breakdown-marker" aria-hidden="true">
                  {current ? '→' : task.status === 'completed' ? '●' : '○'}
                </span>
                <span className="work-breakdown-title">
                  {task.priority ? `${task.priority}：` : ''}
                  {task.title}
                </span>
                <span className="work-breakdown-state">{STATUS_LABEL[task.status]}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {breakdown.currentTaskId && (
        <p className="muted work-breakdown-current">
          当前执行：{breakdown.tasks.find(item => item.workTaskId === breakdown.currentTaskId)?.title ?? breakdown.currentTaskId}
        </p>
      )}
      <p className="muted work-breakdown-source">
        来源：{breakdown.source === 'work-events' ? '分解事件' : '计划步骤派生'}（真实事件投影）
      </p>
    </section>
  );
}
