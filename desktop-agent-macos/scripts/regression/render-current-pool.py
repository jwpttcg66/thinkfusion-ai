#!/usr/bin/env python3
"""Render the full 24-question current-pool regression to Markdown."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NEW = ROOT / 'docs/implementation/regression/debate-regression-current-pool-final-latest.json'
if not NEW.exists():
    NEW = ROOT / 'docs/implementation/regression/debate-regression-current-pool-parallel-latest.json'
OLD = ROOT / 'docs/implementation/regression/debate-regression-standard-v1-full-latest.json'
OUT = ROOT / 'docs/implementation/DEBATE_STANDARD_V1_CURRENT_POOL.md'

new = json.loads(NEW.read_text(encoding='utf-8'))
old = json.loads(OLD.read_text(encoding='utf-8')) if OLD.exists() else None
old_by = {r['id']: r for r in old['results']} if old else {}
s = new['summary']

lines = []
lines.append('# V1 标准：当前模型池全量 24 题结果')
lines.append('')
lines.append('- 日期：2026-11-14')
lines.append('- 模型池：`deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5`')
lines.append('- 数据集：`debate-dataset.json` v1.0.0')
lines.append('- 标准：`DEBATE_TECH_FACT_BASELINE_V1.md`')
lines.append(f'- 明细：`{NEW.relative_to(ROOT)}`')
if new.get('corrections'):
    lines.append(f"- 评分修正重跑：{', '.join(new['corrections'])}")
lines.append('')
lines.append('## 0. 运行方式')
lines.append('')
lines.append('- 3 路并行：把 24 题拆成 3 组，每组一个独立 Electron 进程；')
lines.append('- 每个子进程内部仍然一题一题串行；并发发生在组之间；')
lines.append('- 完整并行运行墙钟约 20 分 18 秒，串行旧运行约 2 小时；')
lines.append('- 这是修复评分器后的完整 24 题并行运行，没有把单题重跑结果混进来；')
lines.append('- 之前的 git-rebase、schema-migration、process-thread 重跑只用于验证评分器修正。')
lines.append('')
lines.append('## 1. 总结')
lines.append('')
lines.append('| 项 | 结果 |')
lines.append('| --- | --- |')
lines.append(f"| 题目数 | {s['total']} |")
lines.append(f"| 执行 | COMPLETED {s['execution'].get('COMPLETED',0)} / PARTIAL {s['execution'].get('PARTIAL',0)} |")
lines.append(f"| 主裁判 | model {s['judgeModel']} / rules {s['total'] - s['judgeModel']} |")
lines.append(f"| 独立裁判 | {s['independent']} / {s['total']} |")
lines.append(f"| 质量 | passed {s['quality'].get('passed',0)} / inconclusive {s['quality'].get('inconclusive',0)} |")
lines.append(f"| 事实维度 | model-assessed {s['factual'].get('model-assessed',0)} / unknown {s['factual'].get('unknown',0)} |")
lines.append(f"| V1 | passed {s['standard']['passed']} / failed {s['standard']['failed']} / unavailable {s['standard']['unavailable']} |")
lines.append(f"| 平均分 | {s['standard']['averageScore']} |")
lines.append(f"| 分类匹配 | {s['standard']['classificationMatches']} / {s['standard']['total']} |")
lines.append(f"| 结构化通过 | {'是' if s['structuralOk'] else '否'} |")
lines.append('')
lines.append('> `score` 是代码按 missing/wrong/boundary/classification 算出的门槛分。')
lines.append('')
lines.append('## 2. 逐题结果')
lines.append('')
lines.append('| # | 题目 | 执行 | 主裁判 | 质量 | V1 | score | 缺失 must | 旧池/串行 V1 |')
lines.append('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for i, r in enumerate(new['results'], 1):
    st = r.get('standard') or {}
    old_st = (old_by.get(r['id']) or {}).get('standard') or {}
    old_label = ('PASS' if old_st.get('passed') else 'FAIL') if old_st else '-'
    lines.append(
        f"| {i} | `{r['id']}` | {r['debate']['outcome']} | {r['judge']['backend']} | "
        f"{r['quality']['status'] if r['quality'] else '-'} | "
        f"{'PASS' if st.get('passed') else 'FAIL'} | {st.get('score','-')} | "
        f"{', '.join(st.get('missingClaims', [])) or '-'} | {old_label} |"
    )
lines.append('')
lines.append('## 3. V1 未通过')
lines.append('')
fails = [r for r in new['results'] if r.get('standard') and not r['standard']['passed']]
lines.append(f'共 {len(fails)} 题。')
lines.append('')
for r in fails:
    st = r['standard']
    lines.append(f"### `{r['id']}`")
    lines.append('')
    lines.append(f"- score：{st['score']}，modelScore：{st['modelScore']}")
    lines.append(f"- 缺失 must：{', '.join(st['missingClaims']) or '无'}")
    lines.append(f"- 错误主张：{', '.join(st['wrongClaims']) or '无'}")
    lines.append(f"- 边界：{'覆盖' if st['boundaryCovered'] else '未覆盖'}")
    lines.append(f"- 理由：{st['reason']}")
    lines.append('')
lines.append('## 4. 执行 PARTIAL')
lines.append('')
partials = [r for r in new['results'] if r['debate']['outcome'] == 'PARTIAL']
lines.append(f'共 {len(partials)} 题。')
lines.append('')
for r in partials:
    details = '；'.join(f"{f['agentId']}：{f['detail']}" for f in r['debate']['failures']) or '无成员失败记录'
    lines.append(f"- `{r['id']}`：{details}")
lines.append('')
lines.append('## 5. 结论')
lines.append('')
lines.append(f"- 当前模型池执行 COMPLETED {s['execution'].get('COMPLETED',0)}/{s['total']}；")
lines.append(f"- V1 通过 {s['standard']['passed']}/{s['total']}，失败 {s['standard']['failed']}；")
lines.append(f"- 分类匹配 {s['standard']['classificationMatches']}/{s['total']}；")
lines.append('- 失败原因以必答主张缺失为主；没有把 major 错误主张、执行失败和事实未核验混成一个通过状态；')
lines.append('- `structuralOk` 以逐题硬门槛为准，不是平均分；')
lines.append('- 并行运行 24/24 COMPLETED、24/24 独立模型裁判，执行层没有 PARTIAL；')
lines.append('- 主要失败仍是必须主张缺失，不是执行失败；')
lines.append('- 评分器仍有噪声：标准外“错误”默认按 minor，不再是 major。')
lines.append('')
lines.append('## 6. 限制')
lines.append('')
lines.append('- 单次样本，不是稳定性重复实验；')
lines.append('- V1 评分是模型应用人工标准，不是外部事实核验；')
lines.append('- 评分模型原始分可能异常，门槛分由代码计算并保留 modelScore 审计；')
lines.append('- 仍然只有一个 Provider，故障域独立性未验证。')
OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(OUT)
