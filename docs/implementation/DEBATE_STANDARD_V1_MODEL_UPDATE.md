# 模型更新后：15 道失败题重跑

- 日期：2026-11-14
- 旧模型池：deepseek-v4.1-flash / gpt-6-luna / kimi-k2.7-code
- 新模型池：deepseek-v4.1-flash / gpt-6-luna / claude-haiku-5-5
- 数据集：`debate-dataset.json` v1.0.0
- 标准：`DEBATE_TECH_FACT_BASELINE_V1.md`
- 明细：`docs/implementation/regression/debate-regression-model-update-latest.json`

## 1. 总结

| 项 | 新结果 |
| --- | --- |
| 重跑题目 | 15 |
| 执行 | COMPLETED 15 / PARTIAL 0 |
| 主裁判 | model 15 / rules 0 |
| 独立裁判 | 15 / 15 |
| 质量 | passed 14 / inconclusive 1 |
| 事实维度 | model-assessed 15 / unknown 0 |
| V1 | passed 8 / failed 7 / unavailable 0 |
| 平均分 | 84 |
| 分类匹配 | 15 / 15 |

## 2. 旧 vs 新

| 题目 | 旧执行 | 旧 V1 | 新执行 | 新质量 | 新 V1 | 新 score | 新缺失 must |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `float-equality` | PARTIAL | PASS 100 | COMPLETED | passed | FAIL | 69 | c2 |
| `array-map` | PARTIAL | PASS 100 | COMPLETED | passed | PASS | 100 | - |
| `http-methods` | COMPLETED | FAIL 65 | COMPLETED | passed | FAIL | 65 | c2 |
| `acid` | COMPLETED | FAIL 69 | COMPLETED | passed | FAIL | 69 | c3 |
| `jwt-revoke` | PARTIAL | PASS 100 | COMPLETED | passed | PASS | 100 | - |
| `csrf-xss` | COMPLETED | FAIL 69 | COMPLETED | passed | FAIL | 69 | c2 |
| `index-generation` | COMPLETED | FAIL 60 | COMPLETED | passed | PASS | 100 | - |
| `schema-migration` | PARTIAL | FAIL 60 | COMPLETED | inconclusive | PASS | 100 | - |
| `feature-flag` | PARTIAL | PASS 100 | COMPLETED | passed | PASS | 100 | - |
| `unicode-utf8` | COMPLETED | FAIL 60 | COMPLETED | passed | PASS | 100 | - |
| `timezone` | COMPLETED | FAIL 69 | COMPLETED | passed | PASS | 100 | - |
| `compression` | PARTIAL | FAIL 69 | COMPLETED | passed | FAIL | 69 | c4 |
| `git-rebase` | COMPLETED | FAIL 69 | COMPLETED | passed | PASS | 100 | - |
| `process-thread` | COMPLETED | FAIL 60 | COMPLETED | passed | FAIL | 60 | c1, c2 |
| `memory-leak` | PARTIAL | FAIL 60 | COMPLETED | passed | FAIL | 60 | c2, c3 |

## 3. 结果变化

- 原失败、现在通过：5 题
  - `index-generation`
  - `schema-migration`
  - `unicode-utf8`
  - `timezone`
  - `git-rebase`
- 原通过、现在失败：1 题
  - `float-equality`
- 仍然失败：7 题
  - `float-equality`：score 69，缺 c2；明确给出结果为 false，并说明实际结果为 0.30000000000000004；未解释这是二进制浮点精度问题，也未给出精确比较的建议。
  - `http-methods`：score 65，缺 c2；正确说明 PUT 幂等、POST 方法语义不保证幂等，并给出 PUT/POST 选型条件及应用层幂等方案；但未明确“幂等不等于响应完全相同”，且对 PATCH 仅称通常不保证幂等，未按标准说明其幂等性取决于补丁格式和服务器实现，边界覆盖不完整。
  - `acid`：score 69，缺 c3；覆盖了 ACID 含义、一致性需约束或应用逻辑保证、隔离性解决的异常及锁/MVCC/重试等代价，且无重大错误；但未明确说明数据库默认隔离级别不一定是可串行化，缺失必须主张 c3。
  - `csrf-xss`：score 69，缺 c2；回答准确区分了XSS与CSRF，并覆盖两者防御重点；未明确说明XSS可绕过部分CSRF防御（如读取CSRF token或以用户身份发起同源请求），故缺少c2。无重大错误主张。
  - `compression`：score 69，缺 c4；答案覆盖了静态资源 Brotli+gzip 回退、动态按实测选择、已压缩内容和小响应不宜再压缩等边界，且无重大错误主张；但未明确动态压缩需协商 Accept-Encoding 并按 Vary 区分缓存变体，也未说明秘密信息与攻击者可控内容需评估 BREACH 类压缩侧信道风险。
  - `process-thread`：score 60，缺 c1, c2；说明了进程通常有独立地址空间、线程共享地址空间，并给出了多线程与多进程的适用场景；也将 GIL 限定在默认 CPython。未说明线程有独立栈、寄存器和程序计数器，未提 Linux 中两者均由 task_struct 表示且可调度；提到协程但未说明是否更快需实测。
  - `memory-leak`：score 60，缺 c2, c3；回答给出了条件性排查框架，覆盖了堆与堆外/原生内存的区分、RSS持续增长不必然等于Java内存泄漏，以及受控复现和修复后验证，且没有出现所列错误主张。但监控部分未明确覆盖PSS，工具部分未明确给出Heap Dump/MAT与NMT/native profiler等堆外分析工具，因此两个必须主张只部分覆盖。

## 4. 结论

- 新模型池把 7 道 `PARTIAL`、1 道裁判回退全部变成 `COMPLETED`，主裁判全部为独立模型；
- 执行层噪声基本消失：15/15 COMPLETED，15/15 独立模型裁判；
- V1 从原来的 4/15 通过提升到 8/15 通过；
- 仍有 7 题缺少 must 主张，是内容完整性问题，不是执行失败；
- `float-equality` 从通过变成失败：新回答没有解释二进制浮点原因（缺 c2）；
- `schema-migration` V1 通过，但主裁判给出 `inconclusive`，质量报告仍标未定论；
- 这不是统一的 24 题新模型池结果：另外 9 道之前通过的题仍用旧模型池。

## 5. 下一步

1. 对剩下 7 道 V1 失败题，先决定是补回答还是把某条 must 降为 should；
2. 如果保留 must，给辩论提示词增加通用的“覆盖边界和常见误区”要求，不要塞标准答案；
3. 用新模型池跑一次完整 24 题，避免 9 旧 + 15 新的混合口径；
4. 重新跑全量后再判断 `structuralOk` 是否能通过。
