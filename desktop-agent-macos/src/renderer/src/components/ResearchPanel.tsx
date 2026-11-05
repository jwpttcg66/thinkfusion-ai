import React, { useEffect, useState } from 'react';
import type {
  CollaborationTaskRecord,
  DebateCleanupOutcome,
  DebateConfigInput,
  DebateLeadMode,
  DebateView,
  ExecutionOptions,
  JudgeVerdictView,
  ProviderHealthInfo,
  UsageSummary
} from '../../../shared/contracts';
import type { ConversationExecutionConfig, Synthesis } from '../../../shared/conversation';

/**
 * 研究设置 / 协作 / 辩论 / 报告。
 *
 * 这一层只读 `agentAPI`，不碰主进程对象。所有输入在 main 侧还会再收敛一次
 * （`normalizeExecutionConfig`），所以这里不做「防恶意输入」，只做让人看得懂。
 */
interface Props {
  config: ConversationExecutionConfig;
  onConfigChange: (patch: Partial<ConversationExecutionConfig>) => void;
  latestSynthesis: Synthesis | null;
  onClose: () => void;
}

type Tab = 'mode' | 'collab' | 'debate' | 'report';

const MODES: Array<{ id: ConversationExecutionConfig['executionMode']; label: string; hint: string }> = [
  { id: 'web', label: '网页', hint: '只问已开启的网页通道；汇总由本地模型读完全部回答后写' },
  { id: 'local', label: '本地', hint: '只问 Ollama，回答与汇总都由它自己完成' },
  { id: 'cloud', label: '云端', hint: '只问已配置 Key 的云端模型；汇总交给本地模型' },
  { id: 'hybrid', label: '混合', hint: '网页与云端回答，本地模型不参与回答、只负责汇总' }
];

/** 融合报告里「谁算的这份综合」。三种后端要能分辨。 */
const BACKEND_LABEL: Record<NonNullable<Synthesis['fusion']>['backend'], string> = {
  local: '本地规则（按句子比对，不联网）',
  'local-model': '本地模型（读完各家回答后归纳）',
  remote: '远程模型 API',
  web: '网页模型主导（读完全部回答后评判）'
};

const LEAD_MODES: Array<{ id: DebateLeadMode; label: string; hint: string }> = [
  { id: 'local', label: '本地主导', hint: '本地模型（或云端模型）给基准观点并交锋；网页通道不参与，内容不往网页发' },
  { id: 'web', label: '网页主导', hint: '网页通道各自独立回答原问题，本地/云端读取全部观点做交叉质疑' },
  { id: 'hybrid', label: '混合', hint: '网页与本地/云端第一轮都独立发言，不设单一主辩，由能读上下文的成员交锋' }
];

const STRATEGIES: Array<{ id: NonNullable<ConversationExecutionConfig['strategy']>; label: string }> = [
  { id: 'smart', label: '智能（规则决定串/并）' },
  { id: 'parallel', label: '并行（分批）' },
  { id: 'all-selected', label: '全模型同时' },
  { id: 'sequential', label: '递进（后一个看前一个）' }
];

export function ResearchPanel({ config, onConfigChange, latestSynthesis, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('mode');
  const [options, setOptions] = useState<ExecutionOptions | null>(null);
  const [health, setHealth] = useState<Record<string, ProviderHealthInfo>>({});
  const [records, setRecords] = useState<CollaborationTaskRecord[]>([]);
  const [debates, setDebates] = useState<DebateView[]>([]);
  const [selectedDebate, setSelectedDebate] = useState<string>('');
  const [verdict, setVerdict] = useState<JudgeVerdictView | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [configDrafts, setConfigDrafts] = useState<Record<string, { baseUrl: string; models: string }>>({});
  const [debateQuestion, setDebateQuestion] = useState('');
  const [debateStrategy, setDebateStrategy] = useState<NonNullable<DebateConfigInput['strategy']>>('standard');
  const [debateRounds, setDebateRounds] = useState(2);
  const [debateLeadMode, setDebateLeadMode] = useState<DebateLeadMode>('hybrid');
  /** null = 还没动过，默认勾选所有当前可用成员。 */
  const [debateSelected, setDebateSelected] = useState<string[] | null>(null);
  const [debateLeadAgentId, setDebateLeadAgentId] = useState('');
  const [cleanup, setCleanup] = useState<DebateCleanupOutcome | null>(null);

  async function load() {
    try {
      const [nextOptions, nextHealth, nextRecords, nextDebates, nextUsage] = await Promise.all([
        window.agentAPI.getExecutionOptions(),
        window.agentAPI.getProviderHealth(),
        window.agentAPI.getCollaborationRecords(),
        window.agentAPI.listDebates(),
        window.agentAPI.getUsage()
      ]);
      setOptions(nextOptions);
      setHealth(nextHealth);
      setRecords(nextRecords);
      setDebates(nextDebates);
      setUsage(nextUsage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (tab === 'collab' || tab === 'debate' || tab === 'report') void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [tab]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // 网页与云端都是往外发的模式，「仅本地」在这两种模式下没有意义。
  const isWeb = config.executionMode === 'web';
  const forcedOutbound = config.executionMode === 'web' || config.executionMode === 'cloud';

  // 候选来自主进程的 health()，不是把注册表里的名字列出来就算数。
  // 没配 Key 的云端模型会出现在清单里，但明确标成不可用。
  const candidates = options?.debateCandidates ?? [];
  // 辩论参与者就是全部可用候选：本地模型是合法发言者（本地主导靠它给基准
  // 观点，网页/混合模式靠它做交叉质疑）。三种主导方式都不要求云端 API。
  const debateParticipants = candidates;
  // 主导必须在被问到的名单里：混合模式下本地模型已经不算来源，所以它只能
  // 当「自动汇总」，不能出现在这里被选中。
  const leadKinds: Array<'web' | 'local' | 'cloud'> = config.executionMode === 'web'
    ? ['web']
    : config.executionMode === 'local'
      ? ['local']
      : config.executionMode === 'cloud'
        ? ['cloud']
        : ['web', 'cloud'];
  const leadOptions = candidates.filter(item => leadKinds.includes(item.type));
  const selectedIds = debateSelected ?? debateParticipants.filter(item => item.available).map(item => item.id);
  const leadChoices = candidates.filter(item => item.available && (
    debateLeadMode === 'web' ? item.type === 'web' : debateLeadMode === 'local' ? item.type !== 'web' : false
  ));
  const leadHint = debateLeadMode === 'hybrid'
    ? '混合模式不设主辩：所有成员第一轮平等独立发言'
    : debateLeadMode === 'local'
      ? '不指定时，取第一个可用的本地模型为主辩（没有本地模型时取云端模型）'
      : '不指定时，取第一个可用的网页通道为主辩';
  function toggleCandidate(id: string) {
    const next = selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id];
    setDebateSelected(next);
  }

  return (
    <div className="diag-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="diag-panel research-panel" role="dialog" aria-label="研究设置">
        <div className="diag-head">
          <b>研究设置</b>
          <div className="research-tabs">
            {([['mode', '执行模式'], ['collab', '协作'], ['debate', '辩论'], ['report', '报告与预算']] as const).map(([id, label]) => (
              <button key={id} type="button" className={`btn ghost${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="diag-actions">
            <button className="btn ghost" type="button" onClick={() => void load()}>刷新</button>
            <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="diag-body">
          {error && <div className="error">{error}</div>}

          {tab === 'mode' && (
            <>
              <h3>执行模式</h3>
              <div className="research-modes">
                {MODES.map(mode => (
                  <button
                    key={mode.id}
                    type="button"
                    className={`research-mode${config.executionMode === mode.id ? ' on' : ''}`}
                    onClick={() => onConfigChange({
                      executionMode: mode.id,
                      // 「仅本地」与往外发的模式互斥：网页和云端的内容本来就
                      // 离开本机，留着 local-only 只会让模式名骗人（选云端、
                      // 实际一个云端都没问）。切换时把隐私模式同步回允许外发，
                      // 下面的下拉会立刻显示这个变化。
                      privacyMode: mode.id === 'web' || mode.id === 'cloud' ? 'allow-cloud' : config.privacyMode
                    })}
                  >
                    <b>{mode.label}</b>
                    <span>{mode.hint}</span>
                  </button>
                ))}
              </div>

              <h3>主导</h3>
              <p className="muted">
                全部回答回来之后，由一位来源当主导，读完整份材料：指出谁错在哪、比较谁的答案更好，然后给出自己的最终答案。
                网页主导只能靠「再发一条消息」把各家答案递进那个页面，所以这一轮会多花一次生成时间。
              </p>
              <select
                value={config.leadAgentId ?? ''}
                onChange={event => onConfigChange({ leadAgentId: event.target.value })}
              >
                <option value="">
                  自动：按「问题 + 答案质量」选一位来源主导
                  {config.executionMode === 'hybrid' ? '（本地模型挑，不参加回答）' : ''}
                </option>
                {leadOptions.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.label}{item.available ? '' : '（不可用）'}
                  </option>
                ))}
              </select>

              <h3>隐私与降级</h3>
              <label className="research-row">
                <span>隐私模式</span>
                <select
                  value={config.privacyMode}
                  onChange={event => onConfigChange({ privacyMode: event.target.value as ConversationExecutionConfig['privacyMode'] })}
                >
                  <option value="allow-cloud">允许外发（网页与云端）</option>
                  <option value="local-only" disabled={forcedOutbound}>仅本地（网页/云端模式下不可用）</option>
                </select>
              </label>
              {forcedOutbound && (
                <p className="muted">
                  {isWeb
                    ? '网页模式的内容本来就发往浏览器页面，因此不能标成「仅本地」；选本地模式才能真正不出本机。'
                    : '云端模式的内容要发给云厂商接口，因此不能标成「仅本地」；确实不能出本机时选本地模式。'}
                </p>
              )}
              <label className="research-row">
                <span>没有可用成员时退回网页</span>
                <input
                  type="checkbox"
                  checked={config.fallbackEnabled}
                  onChange={event => onConfigChange({ fallbackEnabled: event.target.checked })}
                />
              </label>
              <p className="muted">「仅本地」下无论是否勾选，都不会退回网页或云端。</p>

              <h3>协作策略</h3>
              <select
                value={config.strategy ?? 'smart'}
                onChange={event => onConfigChange({ strategy: event.target.value as ConversationExecutionConfig['strategy'] })}
              >
                {STRATEGIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>

              <h3>参与模型</h3>
              {options && (
                <div className="research-lists">
                  <Picker title="网页通道" items={options.webChannels}
                    selected={config.selectedWebChannels} all={options.webChannels.map(item => item.id)}
                    onChange={next => onConfigChange({ selectedWebChannels: next })} />
                  <Picker title="本地模型（仅「本地」模式参与回答）" items={options.localModels.map(id => ({ id, label: id }))}
                    selected={config.selectedLocalModels} all={options.localModels}
                    onChange={next => onConfigChange({ selectedLocalModels: next })} />
                  <Picker title="云端模型"
                    items={options.cloudMembers.map(item => ({ ...item, note: item.hasKey ? undefined : '无 Key' }))}
                    selected={config.selectedCloudModels} all={options.cloudMembers.map(item => item.id)}
                    onChange={next => onConfigChange({ selectedCloudModels: next })} />
                </div>
              )}
              <p className="muted">
                不勾任何一项表示「全部」；明确清空某一组表示这一轮不选它。
                本地模型不是来源：网页/云端/混合模式下它不参与回答，只在汇总时读完全部回答写结论；
                只有「本地」模式才会把它当回答者。
              </p>

              <h3>云端服务</h3>
              <p className="muted">每个服务的端点和模型都能改。云厂商改模型名比改文档还快，写死会在某天开始报 404；改完立刻生效，重启也保留。</p>
              {options?.cloudProviders.map(item => {
                const draft = configDrafts[item.id] ?? { baseUrl: item.baseUrl, models: item.models.join(', ') };
                return (
                  <div key={item.id} className="research-cloud">
                    <div className="research-row">
                      <b>{item.label}</b>
                      <span className={`research-tag${item.hasKey ? ' ok' : ''}`}>{item.hasKey ? '已配置 Key' : '未配置 Key'}</span>
                    </div>
                    {item.note && <p className="muted">{item.note}</p>}
                    <div className="research-row">
                      <span>端点</span>
                      <input value={draft.baseUrl}
                        onChange={event => setConfigDrafts(prev => ({ ...prev, [item.id]: { ...draft, baseUrl: event.target.value } }))} />
                      <span>模型</span>
                      <input value={draft.models} placeholder="逗号分隔"
                        onChange={event => setConfigDrafts(prev => ({ ...prev, [item.id]: { ...draft, models: event.target.value } }))} />
                      <button className="btn ghost" type="button" disabled={busy}
                        onClick={() => void run(async () => {
                          await window.agentAPI.setCloudConfig({
                            id: item.id,
                            baseUrl: draft.baseUrl,
                            models: draft.models.split(/[,，\n]/).map(value => value.trim()).filter(Boolean)
                          });
                          setConfigDrafts(prev => { const next = { ...prev }; delete next[item.id]; return next; });
                        })}>保存</button>
                    </div>
                    <div className="research-row">
                      <span>API Key</span>
                      <input type="password" placeholder={item.hasKey ? '已配置，输入新值可替换' : '粘贴 API Key'}
                        value={keyDrafts[item.id] ?? ''}
                        onChange={event => setKeyDrafts(prev => ({ ...prev, [item.id]: event.target.value }))} />
                      <button className="btn" type="button" disabled={busy || !(keyDrafts[item.id] ?? '').trim()}
                        onClick={() => void run(async () => {
                          await window.agentAPI.setApiKey({ id: item.id, key: keyDrafts[item.id] });
                          setKeyDrafts(prev => ({ ...prev, [item.id]: '' }));
                        })}>保存 Key</button>
                      <button className="btn ghost" type="button" disabled={busy || !item.hasKey}
                        onClick={() => void run(() => window.agentAPI.removeApiKey(item.id))}>移除</button>
                    </div>
                  </div>
                );
              })}
              <p className="muted">Key 只存主进程的系统加密区，界面上只看得到「已配置 / 未配置」，不会回显。</p>
            </>
          )}

          {tab === 'collab' && (
            <>
              <h3>最近一轮的子任务记录</h3>
              {records.length === 0 && <p className="muted">还没有协作记录。选一个非默认策略发起一次提问后，这里会显示每个子任务的状态。</p>}
              {records.length > 0 && (
                <table className="research-table">
                  <thead><tr><th>任务</th><th>成员</th><th>轮次</th><th>状态</th><th>尝试</th><th>前序</th><th>耗时</th></tr></thead>
                  <tbody>
                    {records.map(record => (
                      <tr key={record.taskId}>
                        <td>{record.taskId}</td><td>{record.label}</td><td>{record.stage}</td>
                        <td>{record.status}</td><td>{record.attempts}</td><td>{record.contextCount}</td>
                        <td>{record.latencyMs ?? '—'}{record.latencyMs !== undefined ? 'ms' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {records.some(record => record.error) && (
                <div className="diag-warn">
                  {records.filter(record => record.error).map(record => <p key={record.taskId}>{record.label}：{record.error}</p>)}
                </div>
              )}
            </>
          )}

          {tab === 'debate' && (
            <>
              <h3>发起辩论</h3>
              <p className="muted">流程由 DebateOrchestrator 这段代码编排，不是某个模型在主持。下面的「主导」决定的是：基准观点由谁给、其他成员围绕谁展开。</p>

              <div className="research-leads">
                {LEAD_MODES.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`research-mode${debateLeadMode === item.id ? ' on' : ''}`}
                    onClick={() => { setDebateLeadMode(item.id); setDebateLeadAgentId(''); }}
                  >
                    <b>{item.label}</b>
                    <span>{item.hint}</span>
                  </button>
                ))}
              </div>

              <h4>参与成员</h4>
              <p className="muted">可用性由 health() 实时判定。不可用的成员不会混进名单，也不会在发起后被静默丢弃。</p>
              <div className="research-candidates">
                {debateParticipants.length === 0 && <p className="muted">正在读取可用成员…</p>}
                {debateParticipants.map(item => {
                  const blocked = !item.available || (debateLeadMode === 'local' && item.type === 'web');
                  return (
                    <label key={item.id} className={`research-candidate${blocked ? ' off' : ''}`} title={item.detail ?? ''}>
                      <input type="checkbox" disabled={blocked} checked={!blocked && selectedIds.includes(item.id)}
                        onChange={() => toggleCandidate(item.id)} />
                      <span className="research-tag">{item.type === 'web' ? '网页' : item.type === 'local' ? '本地' : '云端'}</span>
                      <span>{item.label}</span>
                      {!item.available && <span className="research-tag">{item.detail ?? '不可用'}</span>}
                      {item.available && debateLeadMode === 'local' && item.type === 'web' && <span className="research-tag">本地主导不参与</span>}
                    </label>
                  );
                })}
              </div>

              <div className="research-row">
                <input value={debateQuestion} placeholder="要辩论的问题" onChange={event => setDebateQuestion(event.target.value)} />
              </div>
              <div className="research-row">
                <select value={debateStrategy} onChange={event => setDebateStrategy(event.target.value as typeof debateStrategy)}>
                  <option value="standard">标准（独立观点 → 交叉质疑）</option>
                  <option value="deep">深度（+ 回应与修正）</option>
                  <option value="adversarial">对抗（主张 / 质疑角色）</option>
                </select>
                <label>轮数 <input type="number" min={1} max={10} value={debateRounds} onChange={event => setDebateRounds(Number(event.target.value))} /></label>
                {debateLeadMode !== 'hybrid' && (
                  <label>主辩
                    <select value={debateLeadAgentId} onChange={event => setDebateLeadAgentId(event.target.value)}>
                      <option value="">自动</option>
                      {leadChoices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                )}
                <button className="btn" type="button" disabled={busy || !debateQuestion.trim() || selectedIds.length === 0}
                  onClick={() => void run(async () => {
                    const started = await window.agentAPI.startDebate({
                      question: debateQuestion,
                      config: {
                        strategy: debateStrategy,
                        maxRounds: debateRounds,
                        leadMode: debateLeadMode,
                        leadAgentId: debateLeadAgentId || undefined,
                        participants: selectedIds
                      }
                    });
                    setSelectedDebate(started.debateId);
                    setVerdict(null);
                    setCleanup(null);
                  })}>开始</button>
              </div>
              <p className="muted">{leadHint}。网页成员只收到用户原话，不接收任何指令，也只在第一轮发言：页面看不到别人的回答，让它每轮发言只是重复独立回答。</p>

              <h3>历史辩论</h3>
              {debates.length === 0 && <p className="muted">还没有辩论记录。</p>}
              {debates.map(item => (
                <div key={item.debateId} className={`research-debate${selectedDebate === item.debateId ? ' on' : ''}`}>
                  <button type="button" className="btn ghost" onClick={() => { setSelectedDebate(item.debateId); void run(async () => setVerdict(await window.agentAPI.getVerdict(item.debateId))); }}>
                    {item.question.slice(0, 40)} · {LEAD_MODES.find(mode => mode.id === item.config.leadMode)?.label ?? '主导未记录'} · {item.lead.label} · {item.rounds.length} 轮 · {item.status}
                  </button>
                  {item.status === 'running' && <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => window.agentAPI.stopDebate(item.debateId))}>停止</button>}
                  {(item.status === 'stopped' || item.status === 'cancelled') && <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => window.agentAPI.resumeDebate(item.debateId))}>继续</button>}
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(async () => setVerdict(await window.agentAPI.adjudicate(item.debateId)))}>裁决</button>
                  <button className="btn ghost" type="button" disabled={busy || item.status === 'running'}
                    onClick={() => void run(async () => {
                      await window.agentAPI.removeDebate(item.debateId);
                      if (selectedDebate === item.debateId) { setSelectedDebate(''); setVerdict(null); setCleanup(null); }
                    })}>删除</button>
                </div>
              ))}

              {(() => {
                const current = debates.find(item => item.debateId === selectedDebate);
                if (!current) return null;
                return (
                  <>
                    <h3>本场主导</h3>
                    <div className="diag-lead">
                      <b>{current.lead.label} · {LEAD_MODES.find(mode => mode.id === current.lead.mode)?.label ?? '主导未记录'}</b>
                      <p className="muted">{current.lead.reason}。流程由代码编排（{current.lead.drivenBy}），不是模型在主持。</p>
                      <p className="muted">{current.plan.reason}</p>
                      <p className="muted">参与成员：{current.plan.participants.join('、') || '无'}；交锋成员：{current.plan.debaters.join('、') || '无'}</p>
                      {current.plan.excluded.length > 0 && (
                        <p className="muted">未参与：{current.plan.excluded.map(item => `${item.id}（${item.reason}）`).join('；')}</p>
                      )}
                      {current.plan.warnings.length > 0 && (
                        <div className="diag-warn">{current.plan.warnings.map((line, index) => <p key={index}>{line}</p>)}</div>
                      )}
                    </div>
                    {current.plan.webOnly.length > 0 && (
                      <div className="research-row">
                        <button className="btn ghost" type="button" disabled={busy}
                          onClick={() => void run(async () => setCleanup(await window.agentAPI.cleanupDebateWeb(current.debateId)))}>
                          清理网页记录
                        </button>
                        <span className="muted">按发言时记下的网页地址删除这一场在各站留下的会话，并把页面移回新对话。</span>
                      </div>
                    )}
                    {cleanup && (
                      <p className="muted">
                        已删：{cleanup.cleaned.join('、') || '无'}；已重置：{cleanup.reset.join('、') || '无'}；
                        失败：{cleanup.failed.map(item => `${item.agentId}（${item.detail}）`).join('、') || '无'}；
                        没有网页地址：{cleanup.noAddress.join('、') || '无'}
                      </p>
                    )}

                    <h3>时间线</h3>
                    {current.rounds.map(round => (
                      <div key={round.index} className="research-round">
                        <b>第 {round.index + 1} 轮{round.converged ? ' · 已收敛' : ''}</b>
                        {round.messages.map(message => (
                          <div key={message.messageId} className="research-message">
                            <span className="research-tag">{message.agentId} / {message.role} / {message.kind}{message.threadUrl ? ' / 有网页会话' : ''}</span>
                            <p>{message.text}</p>
                          </div>
                        ))}
                        {round.failures.map(failure => <p key={failure.agentId} className="muted">{failure.agentId}：{failure.detail}</p>)}
                      </div>
                    ))}
                    {current.minorities.length > 0 && (
                      <div className="diag-warn"><b>少数派观点</b>{current.minorities.map(item => <p key={item.messageId}>{item.text}</p>)}</div>
                    )}
                  </>
                );
              })()}

              {verdict && (
                <>
                  <h3>裁决（{verdict.backend === 'rules' ? '规则版' : '独立模型'}）</h3>
                  <p><b>结论：</b>{verdict.conclusion ?? '无法确定'}</p>
                  <p className="muted">{verdict.reason}</p>
                  <p className="muted">置信度：{verdict.confidence.level} · {verdict.confidence.why}</p>
                  {verdict.fallbackReason && <p className="muted">{verdict.fallbackReason}</p>}
                  {verdict.unresolved.length > 0 && <p className="muted">未解决：{verdict.unresolved.map(item => item.question).join('；')}</p>}
                </>
              )}
            </>
          )}

          {tab === 'report' && (
            <>
              <h3>最近一次综合</h3>
              {!latestSynthesis && <p className="muted">还没有综合报告。</p>}
              {latestSynthesis && (
                <>
                  <p>{latestSynthesis.recommendation}</p>
                  {latestSynthesis.degraded && <div className="diag-warn">这是一份降级报告：没有跨通道共识，不能当成一致结论。</div>}
                  {latestSynthesis.fusion ? (
                    <dl className="diag-grid">
                      <dt>后端</dt><dd>{BACKEND_LABEL[latestSynthesis.fusion.backend] ?? latestSynthesis.fusion.backend}</dd>
                      <dt>最终结论</dt><dd>{latestSynthesis.fusion.finalDecision ?? '未裁决 / 无法确定'}</dd>
                      <dt>置信度</dt><dd>{latestSynthesis.fusion.confidence.level} · {latestSynthesis.fusion.confidence.why}</dd>
                      <dt>证据 / 关系</dt><dd>{latestSynthesis.fusion.evidenceCount} 条 / {latestSynthesis.fusion.relationCount} 条边</dd>
                      <dt>被否定观点</dt><dd>{latestSynthesis.fusion.rejected.length} 条（原文保留）</dd>
                      <dt>未解决问题</dt><dd>{latestSynthesis.fusion.unresolvedQuestions.length} 条</dd>
                    </dl>
                  ) : <p className="muted">规则版综合，没有融合摘要。</p>}
                  {latestSynthesis.fusion && latestSynthesis.fusion.limits.length > 0 && (
                    <details><summary>这一版算法做不到的事</summary>
                      <ul>{latestSynthesis.fusion.limits.map((line, index) => <li key={index}>{line}</li>)}</ul>
                    </details>
                  )}
                </>
              )}

              <h3>预算统计</h3>
              {!usage && <p className="muted">还没有配置云端 Provider，没有 token / 费用数据。</p>}
              {usage && (
                <dl className="diag-grid">
                  <dt>云端调用</dt><dd>{usage.calls} 次</dd>
                  <dt>Token</dt><dd>输入 {usage.inputTokens} / 输出 {usage.outputTokens}</dd>
                  <dt>费用</dt><dd>{usage.cost.length > 0 ? usage.cost.map(item => `${item.amount.toFixed(6)} ${item.currency}`).join('，') : '未配置单价，不估算'}</dd>
                  <dt>服务端没给 usage</dt><dd>{usage.unknownUsageCalls} 次（没有当成 0）</dd>
                </dl>
              )}

              <h3>来源状态</h3>
              <dl className="diag-grid">
                {Object.entries(health).map(([id, item]) => (
                  <React.Fragment key={id}>
                    <dt>{id}</dt><dd>{item.available ? '可用' : '不可用'}{item.detail ? ` · ${item.detail}` : ''}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  );


}

/** 提到组件外：定义在 render 里的组件类型每次都会变，输入框会丢焦点。 */
function toggle(list: string[] | undefined, id: string, all: string[]): string[] {
  const current = list ?? all;
  return current.includes(id) ? current.filter(item => item !== id) : [...current, id];
}

  /**
   * 勾选清单。
   *
   * `id` 是真正发给主进程的值，`label` 只是显示用的——云端同名模型出现在
   * 两个服务里时必须能分开勾。
   */
  function Picker({ title, items, selected, all, onChange }: {
  title: string;
  items: Array<{ id: string; label: string; note?: string }>;
  selected: string[] | undefined;
  all: string[];
  onChange: (next: string[]) => void;
}) {
  const current = selected ?? all;
  return (
    <div className="research-picker">
      <b>{title}</b>
      {items.length === 0 && <span className="muted">没有可选成员</span>}
      {items.map(item => (
        <label key={item.id}>
          <input type="checkbox" checked={current.includes(item.id)} onChange={() => onChange(toggle(current, item.id, all))} />
          {item.label}
          {item.note && <span className="muted">（{item.note}）</span>}
        </label>
      ))}
    </div>
  );
}
