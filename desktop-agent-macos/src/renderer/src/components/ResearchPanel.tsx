import React, { useEffect, useState } from 'react';
import type {
  CollaborationTaskRecord,
  DebateClaimView,
  DebateCleanupOutcome,
  DebateConfigInput,
  DebateLeadMode,
  DebateView,
  ExecutionOptions,
  JudgeVerdictView,
  ProviderHealthInfo,
  RelatedDebateView,
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
  { id: 'web', label: '网页主导', hint: '知识空间：只用网页通道汇总交锋。工程空间：本地+云端模型编排，不问网页' },
  { id: 'local', label: '本地主导', hint: '知识空间：只用本机 Ollama。工程空间：本地+云端模型编排，本地优先主导' },
  { id: 'cloud', label: '云端主导', hint: '知识空间：只用远程 API 模型。工程空间：本地+云端模型编排，不按归属挑人' },
  { id: 'hybrid', label: '混合主导', hint: '知识空间：先择一类再严格只用那一类。工程空间：唯一允许网页加入编排的模式' }
];

/** 融合报告里「谁算的这份综合」。三种后端要能分辨。 */
const BACKEND_LABEL: Record<NonNullable<Synthesis['fusion']>['backend'], string> = {
  local: '本地规则（按句子比对，不联网）',
  'local-model': '本地模型（读完各家回答后归纳）',
  remote: '远程模型 API',
  web: '网页模型主导（读完全部回答后评判）'
};

const LEAD_MODES: Array<{ id: DebateLeadMode; label: string; hint: string }> = [
  { id: 'local', label: '本地主导', hint: '只用本地模型：汇总、交锋、最终意见都在本机完成，内容不往网页发' },
  { id: 'web', label: '网页主导', hint: '只用网页通道：不引入本地/云端模型，交锋材料拼成一条消息递进页面' },
  { id: 'cloud', label: '云端主导', hint: '只用远程 API 模型：需要配好 Key，不占本机算力' },
  { id: 'hybrid', label: '混合', hint: '先综合决定采用本地 / 网页 / 云端中的哪一种，再严格只用那一类成员' }
];

const STRATEGIES: Array<{ id: NonNullable<ConversationExecutionConfig['strategy']>; label: string }> = [
  { id: 'smart', label: '智能（规则决定串/并）' },
  { id: 'parallel', label: '并行（分批）' },
  { id: 'all-selected', label: '全模型同时' },
  { id: 'sequential', label: '递进（后一个看前一个）' }
];

/**
 * 六种辩论协作策略（任务书 4.2）。
 *
 * 这里的 `summary` 与主进程 `strategies.ts` 一致，但故意各写一份：渲染层
 * 不依赖 main，多写一行字比打通一条 import 便宜。两处不一样时以 main 为准
 * ——它才是真的改行为的地方。
 */
const DEBATE_STRATEGIES: Array<{
  id: NonNullable<DebateConfigInput['strategy']>;
  label: string;
  summary: string;
  rounds: number;
}> = [
  { id: 'truth', label: '真理发现', summary: '先给结论，再检验证据链；证据不足就改口', rounds: 3 },
  { id: 'adversarial', label: '对抗辩论', summary: '优先找反例、漏洞和隐藏假设；主张 / 质疑分工', rounds: 3 },
  { id: 'expert', label: '专家评审', summary: '按领域证据标准判断，指出证据等级被高估', rounds: 3 },
  { id: 'assumption', label: '假设审查', summary: '前提逐条列出并逐项核对，被推翻就改结论', rounds: 3 },
  { id: 'solution', label: '方案竞争', summary: '多个候选方案按约束、风险、证据对比后收敛', rounds: 3 },
  { id: 'discovery', label: '探索发现', summary: '并行假设，用能区分它们的证据逐步排除', rounds: 3 }
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
  const [debateQuestion, setDebateQuestion] = useState('');
  const [debateStrategy, setDebateStrategy] = useState<NonNullable<DebateConfigInput['strategy']>>('truth');
  const [debateRounds, setDebateRounds] = useState(3);
  const [debateEarlyStop, setDebateEarlyStop] = useState(false);
  const [debateLeadMode, setDebateLeadMode] = useState<DebateLeadMode>('hybrid');
  /** null = 还没动过，默认勾选所有当前可用成员。 */
  const [debateSelected, setDebateSelected] = useState<string[] | null>(null);
  const [debateLeadAgentId, setDebateLeadAgentId] = useState('');
  const [cleanup, setCleanup] = useState<DebateCleanupOutcome | null>(null);
  const [related, setRelated] = useState<RelatedDebateView[]>([]);

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

  // 候选来自主进程的 health()，不是把注册表里的名字列出来就算数。
  // 没配 Key 的云端模型会出现在清单里，但明确标成不可用。
  const candidates = options?.debateCandidates ?? [];
  // 辩论页参与者就是全部可用候选（独立子系统，与执行模式无关）。
  const debateParticipants = candidates;
  /** 归属规则：一种方式只用一类成员；混合先择一，界面不预先排除任何人。 */
  const ownerType: 'web' | 'local' | 'cloud' | null = debateLeadMode === 'web' ? 'web'
    : debateLeadMode === 'local' ? 'local'
      : debateLeadMode === 'cloud' ? 'cloud' : null;
  const selectedIds = debateSelected ?? debateParticipants
    .filter(item => item.available && (ownerType === null || item.type === ownerType))
    .map(item => item.id);
  const leadChoices = candidates.filter(item => item.available && item.type === ownerType);
  const leadHint = debateLeadMode === 'hybrid'
    ? '混合先综合决定采用哪一种方式，主辩由系统按决定挑，不指定'
    : `不指定时，取第一个可用的${ownerType === 'web' ? '网页通道' : ownerType === 'local' ? '本地模型' : '云端模型'}为主辩`;
  // 会话执行模式 = 由哪一类成员执行。主导人可选范围按归属规则收窄：
  // 网页主导挑网页通道，本地/云端主导挑同类模型，混合择一后由系统挑。
  const leadKind = config.executionMode === 'local'
    ? 'local'
    : config.executionMode === 'cloud'
      ? 'cloud'
      : 'web';
  const leadOptions = candidates.filter(item => item.available && item.type === leadKind);
  const showLeadPicker = config.executionMode !== 'hybrid';
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
              <h3>执行模式 = 由哪一类成员执行</h3>
              <p className="muted">
                知识空间里回答永远来自网页通道。按<b>归属规则</b>，执行模式决定回答之后的三件事由哪一类成员做：
                本地主导只用本地模型、网页主导只用网页、云端主导只用远程 API，混合先综合决定采用哪一种；
                只有一个可用成员时由它一个主导（自辩）。三件事是：① 汇总全部网页回答（结论 / 一致 / 分歧 / 存疑）；
                ② 从分歧里指定辩题；③ 读辩论记录，给出最终意见。没有实质分歧时不发起辩论。
              </p>
              <p className="muted">
                <b>工程空间不同</b>：那里要读本机文件，网页读不到，所以<b>第一意见</b>由模型读工程证据给出
                （本地优先，云端主导时才用云端），一个可用模型都没有才退回网页。知识空间的网页提问不受影响。
              </p>

              <h3>工程空间：网页编排（仅混合档）</h3>
              <p className="muted">
                工程空间默认是<b>多 agent 编排</b>：可用的本地模型 + 云端模型都来读你的文件，
                各给一份意见，再由本地优先的主导人汇总、指定辩题交锋、给最终意见。
                网页看不到本机文件，<b>只有下面的执行模式选「混合」时</b>才被允许作为编排成员
                一起进场（带用户原话 + 证据摘录，最多 6000 字）；本地 / 网页 / 云端三档一个网页都不问。
                混合档下的开关决定网页什么时候加入：自动只在重大决策（选型、迁移、重构、风险取舍）
                时加入，读数 / 查事实类问题不加。每个网页都要重新加载并等它写完，会多花 1–3 分钟。
              </p>
              <select
                value={config.webSecondOpinion ?? 'auto'}
                onChange={event => onConfigChange({
                  webSecondOpinion: event.target.value as ConversationExecutionConfig['webSecondOpinion']
                })}
              >
                <option value="auto">自动（混合档下只在重大决策时编排网页）</option>
                <option value="always">总是（混合档下每次都编排网页）</option>
                <option value="off">关闭（混合档也只用本地/云端模型）</option>
              </select>

              <div className="research-modes">
                {MODES.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`research-mode${config.executionMode === item.id ? ' on' : ''}`}
                    onClick={() => onConfigChange({ executionMode: item.id })}
                  >
                    <b>{item.label}</b>
                    <span>{item.hint}</span>
                  </button>
                ))}
              </div>

              <h3>主导人</h3>
              {showLeadPicker ? (
                <>
                  <p className="muted">
                    {config.executionMode === 'web'
                      ? '由哪个网页通道当主导。它读不到别人的页面，只能由我们把材料拼成一条用户消息发进去——汇总、交锋、最终意见都在网页侧完成，不会调用本地/云端模型。'
                      : config.executionMode === 'local'
                        ? '由哪个本地模型当主导。汇总、定辩题、交锋与最终意见都在本机完成，不调云端 API。'
                        : '由哪个云端模型当主导。汇总、交锋与最终意见都走远程 API，不掺本地模型。'}
                  </p>
                  <select
                    value={config.leadAgentId ?? ''}
                    onChange={event => onConfigChange({ leadAgentId: event.target.value })}
                  >
                    <option value="">不指定：取第一个可用的{config.executionMode === 'web' ? '网页通道' : config.executionMode === 'local' ? '本地模型' : '云端模型'}</option>
                    {leadOptions.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.label}{item.available ? '' : '（不可用）'}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className="muted">
                  混合主导不预先指定人：先按可用成员与你的选择综合决定采用本地 / 网页 / 云端中的哪一种方式，再严格只用那一类成员，由它完成汇总、交锋与最终意见。
                </p>
              )}

              <h3>协作策略</h3>
              <select
                value={config.strategy ?? 'smart'}
                onChange={event => onConfigChange({ strategy: event.target.value as ConversationExecutionConfig['strategy'] })}
              >
                {STRATEGIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>

              <h3>辩论开关（V2.1）</h3>
              <p className="muted">
                自动＝主导人找到实质分歧才辩；关闭＝这一轮只汇总，不交锋、不出最终意见；
                开启＝即使没有分歧也辩一次。用户明确关闭时不会强制启动。
              </p>
              <select
                value={config.debateMode ?? 'auto'}
                onChange={event => onConfigChange({
                  debateMode: event.target.value as 'auto' | 'on' | 'off'
                })}
              >
                <option value="auto">自动（有分歧才辩）</option>
                <option value="on">开启（一定辩）</option>
                <option value="off">关闭（不辩）</option>
              </select>

              <h3>研究轮次（P6）</h3>
              <p className="muted">
                单轮＝问一遍就汇总，和以前一样。选了多轮后，主导人汇总时要多写一段【待补】——
                还缺哪些具体事实；系统把这些缺口拼成一个问题，重新问一遍<b>所有</b>网页通道，再让主导人更新汇总。
                每多一轮＝所有网页通道各多答一次 + 主导人多写一次汇总，等待时间也相应变长；没有缺口时这一轮不会发生。
              </p>
              <select
                value={String(config.followUpRounds ?? 0)}
                onChange={event => onConfigChange({ followUpRounds: Number(event.target.value) })}
              >
                <option value="0">单轮（默认，不追加）</option>
                <option value="1">最多 1 轮追加</option>
                <option value="2">最多 2 轮追加</option>
                <option value="3">最多 3 轮追加</option>
              </select>

              <h3>辩论策略</h3>
              <p className="muted">
                主导人指定辩题后，辩手按这套策略交锋。它和执行模式相互独立：
                四种执行模式都能配下面任意一种策略，换策略不改裁判口径。
              </p>
              <select
                value={config.debateStrategy ?? 'truth'}
                onChange={event => onConfigChange({ debateStrategy: event.target.value as ConversationExecutionConfig['debateStrategy'] })}
              >
                {DEBATE_STRATEGIES.map(item => <option key={item.id} value={item.id}>{item.label} · {item.summary}</option>)}
              </select>

              <h3>参与成员</h3>
              {options && (
                <div className="research-lists">
                  <Picker title="网页通道（回答者）" items={options.webChannels}
                    selected={config.selectedWebChannels} all={options.webChannels.map(item => item.id)}
                    onChange={next => onConfigChange({ selectedWebChannels: next })} />
                  <Picker title="云端模型（可当主导/辩手）"
                    items={options.cloudMembers.map(item => ({ ...item, note: item.hasKey ? undefined : '无 Key' }))}
                    selected={config.selectedCloudModels} all={options.cloudMembers.map(item => item.id)}
                    onChange={next => onConfigChange({ selectedCloudModels: next })} />
                </div>
              )}
              <p className="muted">
                不勾任何一项表示「全部」；明确清空某一组表示这一轮不选它。
                知识空间的第一轮回答只问网页通道。之后的汇总、交锋与最终意见按归属规则执行：网页主导只用网页，本地/云端主导只用各自模型，混合择一，不混用。
                工程空间的第一意见由模型读证据给出；网页第二意见取上面勾选通道里的第一个。
              </p>
              <p className="muted">
                云端服务的端点、模型和 API Key 统一在「设置 → 模型 → 云端 API 模型」里配；这一页只决定哪些成员参与，
                没配 Key 的服务会标成不可用，不在这里填凭据。
              </p>
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
                  const blocked = !item.available || (ownerType !== null && item.type !== ownerType);
                  return (
                    <label key={item.id} className={`research-candidate${blocked ? ' off' : ''}`} title={item.detail ?? ''}>
                      <input type="checkbox" disabled={blocked} checked={!blocked && selectedIds.includes(item.id)}
                        onChange={() => toggleCandidate(item.id)} />
                      <span className="research-tag">{item.type === 'web' ? '网页' : item.type === 'local' ? '本地' : '云端'}</span>
                      <span>{item.label}</span>
                      {!item.available && <span className="research-tag">{item.detail ?? '不可用'}</span>}
                      {item.available && ownerType !== null && item.type !== ownerType && <span className="research-tag">归属方式不使用这一类</span>}
                    </label>
                  );
                })}
              </div>

              <div className="research-row">
                <input value={debateQuestion} placeholder="要辩论的问题" onChange={event => setDebateQuestion(event.target.value)} />
                <button className="btn ghost" type="button" disabled={busy || !debateQuestion.trim()}
                  onClick={() => void run(async () => {
                    setRelated(await window.agentAPI.relatedDebates({ question: debateQuestion, exclude: selectedDebate || undefined }));
                  })}>
                  查历史
                </button>
              </div>

              <h4>协作策略</h4>
              <div className="research-strategies">
                {DEBATE_STRATEGIES.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`research-mode${debateStrategy === item.id ? ' on' : ''}`}
                    onClick={() => { setDebateStrategy(item.id); setDebateRounds(item.rounds); }}
                  >
                    <b>{item.label}</b>
                    <span>{item.summary}</span>
                  </button>
                ))}
              </div>
              <p className="muted">
                策略改的是「每轮问什么、谁是什么角色、先处理哪类争议」，不改裁判口径——
                同一份证据换策略跑，结论应当一样。
              </p>

              <div className="research-row">
                <label>轮数 <input type="number" min={1} max={10} value={debateRounds} onChange={event => setDebateRounds(Number(event.target.value))} /></label>
                <label title="连续两轮没有新增证据、没有实质修订、也没有新争议时提前收尾">
                  <input type="checkbox" checked={debateEarlyStop} onChange={event => setDebateEarlyStop(event.target.checked)} />
                  没进展就提前收尾（省调用）
                </label>
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
                        earlyStopOnStall: debateEarlyStop || undefined,
                        participants: selectedIds
                      }
                    });
                    setSelectedDebate(started.debateId);
                    setVerdict(null);
                    setCleanup(null);
                    setRelated([]);
                  })}>开始</button>
              </div>
              <p className="muted">{leadHint}。归属规则：本地主导只用本地模型、网页主导只用网页、云端主导只用远程 API、混合先择一；只有一个可用成员时由它一个主导（自辩）。网页通道只收到用户消息，交锋材料拼在消息里，不发 system / context 指令。</p>

              {related.length > 0 && (
                <>
                  <h4>历史上辩过相似问题</h4>
                  <p className="muted">只是提示：旧结论可能已经过时，要不要复用由你决定，系统不会自动跳过。</p>
                  {related.map(item => (
                    <div key={item.debateId} className="research-related">
                      <button type="button" className="btn ghost" onClick={() => { setSelectedDebate(item.debateId); void run(async () => setVerdict(await window.agentAPI.getVerdict(item.debateId))); }}>
                        {item.question.slice(0, 46)} · 相似度 {item.similarity}
                      </button>
                      <span className="muted">
                        {DEBATE_STRATEGIES.find(strategy => strategy.id === item.strategy)?.label ?? item.strategy}
                        {' · '}{item.verdict ?? '没有结论'}{item.conclusion ? ` · ${item.conclusion.slice(0, 40)}` : ''}
                      </span>
                    </div>
                  ))}
                </>
              )}

              <h3>历史辩论</h3>
              {debates.length === 0 && <p className="muted">还没有辩论记录。</p>}
              {debates.map(item => (
                <div key={item.debateId} className={`research-debate${selectedDebate === item.debateId ? ' on' : ''}`}>
                  <button type="button" className="btn ghost" onClick={() => { setSelectedDebate(item.debateId); void run(async () => setVerdict(await window.agentAPI.getVerdict(item.debateId))); }}>
                    {item.question.slice(0, 40)} · {DEBATE_STRATEGIES.find(strategy => strategy.id === item.config.strategy)?.label ?? item.config.strategy} · {LEAD_MODES.find(mode => mode.id === item.config.leadMode)?.label ?? '主导未记录'} · {item.lead.label} · {item.rounds.length} 轮 · {item.status}
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
                    <DebateReport debate={current} />
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

/**
 * 一场辩论的完整结果报告（任务书 13.2）。
 *
 * 只渲染落盘数据，不在界面上补算：能上屏的每一条都能在 `DebateState` 里
 * 找到原文。裁判结论、证据链、修订记录、指标各占一块，谁也不合并成
 * 一个「综合评分」——那个数字没法解释自己是怎么来的。
 */
function DebateReport({ debate }: { debate: DebateView }) {
  const claims = new Map<string, DebateClaimView>();
  for (const round of debate.rounds) {
    for (const claim of round.claims ?? []) claims.set(claim.claimId, claim);
  }
  const verdict = debate.verdict;
  const judgments = debate.judgments ?? [];
  const evidence = debate.evidence ?? [];
  const revisions = debate.revisions ?? [];
  const disputes = debate.disputes ?? [];
  const metrics = debate.metrics;
  const references = new Map<string, { url: string; title?: string; count: number }>();
  for (const item of evidence) {
    const url = item.finalUrl ?? item.url;
    if (!url) continue;
    const existing = references.get(url);
    if (existing) existing.count += 1;
    else references.set(url, { url, title: item.pageTitle, count: 1 });
  }
  // 「反例与边界」看反例维度的结论：refuted/limited 才是结论不适用，none 不是。
  const boundaries = judgments
    .map(item => ({
      claim: item.claimText,
      dimension: item.dimensions.find(dimension => dimension.dimension === 'counterexample')
    }))
    .filter(item => item.dimension && item.dimension.outcome !== 'none');

  return (
    <div className="debate-report">
      <h3>结论</h3>
      {!verdict && <p className="muted">还没有结论：这一场没跑完，或者没有抽出可判真假的主张。</p>}
      {verdict && (
        <>
          <div className={`verdict-banner verdict-${verdict.verdict}`}>
            <b>{VERDICT_LABEL[verdict.verdict] ?? verdict.verdict}</b>
            <span>{verdict.conclusion ?? '没有可判定的结论'}</span>
          </div>
          <p className="muted">{verdict.rationale}</p>
          {verdict.minorityWins && (
            <div className="diag-warn">少数派胜出：{verdict.minorityReason ?? '它的证据比多数派更强'}</div>
          )}
          <div className="verdict-dimensions">
            {verdict.dimensions.map(dimension => (
              <div key={dimension.dimension} className="verdict-dimension">
                <b>{DIMENSION_LABEL[dimension.dimension] ?? dimension.dimension} · {dimension.outcome}</b>
                <span>{dimension.rationale}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>关键主张</h3>
      {judgments.length === 0 && <p className="muted">没有判过的主张。</p>}
      {judgments.map(item => (
        <div key={item.claimId} className="research-message">
          <span className="research-tag">{item.agentId} · {CLAIM_STATUS_LABEL[claims.get(item.claimId)?.status ?? ''] ?? claims.get(item.claimId)?.status ?? '未记录'} · {item.verdict}</span>
          <p>{item.claimText}</p>
          <p className="muted">{item.rationale}</p>
        </div>
      ))}

      <h3>证据链</h3>
      {evidence.length === 0 && <p className="muted">这一场没有采集到证据（网页成员没给链接时，只有主张自己的说法）。</p>}
      {evidence.map(item => (
        <div key={item.evidenceId} className="research-message">
          <span className="research-tag">{EVIDENCE_LABEL[item.verified] ?? item.verified}{item.independent ? '' : ' · 与别的记录同源'}</span>
          <p>{item.excerpt}</p>
          <p className="muted">
            {(item.finalUrl ?? item.url) ? <a href={item.finalUrl ?? item.url} target="_blank" rel="noreferrer">{item.finalUrl ?? item.url}</a> : '没有地址（只有主张自己的说法）'}
            {item.pageTitle ? ` · ${item.pageTitle}` : ''}
          </p>
          <p className="muted">{item.assessment}</p>
        </div>
      ))}

      <h3>主要分歧</h3>
      {disputes.length === 0 && <p className="muted">没有判出跨参与者的分歧。</p>}
      {disputes.map(item => (
        <div key={item.disputeId} className="research-message">
          <span className="research-tag">第 {item.roundIndex + 1} 轮 · {DISPUTE_LABEL[item.type] ?? item.type}</span>
          <p>{item.reason}</p>
        </div>
      ))}

      <h3>反例与边界</h3>
      {boundaries.length === 0 && <p className="muted">没有主张被判成需要限制或已被反例推翻。</p>}
      {boundaries.map((item, index) => (
        <div key={index} className="research-message">
          <span className="research-tag">反例 · {item.dimension?.outcome}</span>
          <p>{item.claim}</p>
          <p className="muted">{item.dimension?.rationale}</p>
        </div>
      ))}

      <h3>修订记录</h3>
      {revisions.length === 0 && <p className="muted">回应阶段没有产生修订记录。</p>}
      {revisions.map(item => (
        <div key={item.revisionId} className="research-message">
          <span className="research-tag">{item.agentId} · {item.decision ?? '未写明'}{item.source === 'inferred' ? '（按措辞推断）' : ''}</span>
          <p className="muted">改之前：{item.before.slice(0, 120) || '（没有更早的发言）'}</p>
          <p>改之后：{item.after.slice(0, 200)}</p>
        </div>
      ))}

      <h3>不确定性</h3>
      {(!verdict || verdict.unresolved.length === 0) ? (
        <p className="muted">结论里没有登记未解决的问题。</p>
      ) : (
        <ul>{verdict.unresolved.map((line, index) => <li key={index}>{line}</li>)}</ul>
      )}

      <h3>参考来源</h3>
      {references.size === 0 && <p className="muted">没有可访问的来源地址。</p>}
      {[...references.values()].map(item => (
        <p key={item.url} className="muted">
          <a href={item.url} target="_blank" rel="noreferrer">{item.title ?? item.url}</a>
          {item.count > 1 ? ` · ${item.count} 条引用都指向这里` : ''}
        </p>
      ))}

      <h3>质量指标</h3>
      {!metrics && <p className="muted">这一场没跑完，没有指标。</p>}
      {metrics && (
        <dl className="diag-grid">
          <dt>证据可追溯率</dt>
          <dd>{rate(metrics.traceability.rate)}（{metrics.traceability.traceable}/{metrics.traceability.judged} 条被判定主张有页面来源）</dd>
          <dt>无效轮次</dt>
          <dd>{rate(metrics.invalidRounds.rate)}（{metrics.invalidRounds.invalid}/{metrics.invalidRounds.total} 轮没有新增证据或实质修订）</dd>
          <dt>少数派保留</dt>
          <dd>{rate(metrics.minority.rate)}（{metrics.minority.preserved}/{metrics.minority.count} 条原文完整保留）</dd>
          <dt>耗时</dt>
          <dd>{Math.round(metrics.latency.totalMs / 1000)} 秒{metrics.latency.averageRoundMs ? `，平均每轮 ${Math.round(metrics.latency.averageRoundMs / 1000)} 秒` : ''}</dd>
          <dt>调用</dt>
          <dd>{metrics.calls.messages} 次发言，{metrics.calls.failures} 次失败</dd>
        </dl>
      )}
      <p className="muted">Token 与费用没有数据来源（网页通道与本地模型都不报用量），这里不估算。</p>
    </div>
  );
}

const VERDICT_LABEL: Record<string, string> = {
  supported: '有证据支持',
  partially_supported: '部分支持',
  unsupported: '不成立',
  contradicted: '被反证推翻',
  insufficient_evidence: '证据不足（不等于错）'
};

const DIMENSION_LABEL: Record<string, string> = {
  logic: '逻辑',
  evidence: '证据',
  counterexample: '反例'
};

const DISPUTE_LABEL: Record<string, string> = {
  factual: '事实冲突',
  logical: '推理对不上',
  scope: '适用范围不同',
  definitional: '定义不同',
  evidence_conflict: '证据冲突'
};

const EVIDENCE_LABEL: Record<string, string> = {
  'page-link': '页面给了链接',
  reported: '自称有出处',
  unverified: '只有断言'
};

const CLAIM_STATUS_LABEL: Record<string, string> = {
  proposed: '提出',
  supported: '有支持',
  challenged: '被质疑',
  revised: '已修正',
  withdrawn: '已撤回',
  unresolved: '未解决'
};

function rate(value: number | null): string {
  return value === null ? '无法计算' : `${Math.round(value * 100)}%`;
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
      <div className="research-picker-head">
        <b>{title}</b>
        <span className="settings-spacer" />
        <span className="muted">{current.length}/{items.length}</span>
        <button
          type="button"
          className="btn ghost"
          disabled={items.length === 0 || current.length === items.length}
          onClick={() => onChange(all)}
        >
          全选
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={current.length === 0}
          onClick={() => onChange([])}
        >
          清空
        </button>
      </div>
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
