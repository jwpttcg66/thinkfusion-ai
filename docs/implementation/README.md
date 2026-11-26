# 实施文档

## 先读

- [STATUS.md](STATUS.md)：唯一当前实现状态、证据指针和已知缺口。
- [plans/README.md](plans/README.md)：未完成或正在进行的计划。
- [features/README.md](features/README.md)：已落地能力的专项说明。
- [acceptance/README.md](acceptance/README.md)：按主题归档的测试/真机验收记录。
- [audits/README.md](audits/README.md)：针对具体代码范围的审计。
- [evidence/README.md](evidence/README.md)：测试输出、CDP 记录、截图等原始证据。
- [../archive/README.md](../archive/README.md)：已完成任务书、历史审计和被取代的文档。

## 使用顺序

1. 以 `STATUS.md` 确认当前状态与缺口。
2. 当前未完成的工作从 `plans/active/` 读取。
3. 通过 `features/` 查看已实现能力的边界；契约本身以 `docs/spec/` 为准。
4. 验收报告只能用于核对其明确覆盖的场景。
5. 历史材料只能解释决策经过，不得作为当前状态或接口依据。

不要在此目录复制 `STATUS.md` 的完整状态表，也不要把旧任务书恢复成新的状态来源。
