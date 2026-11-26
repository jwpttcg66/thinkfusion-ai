# ThinkFusion V3 整体架构：Goal → TDL → Cycle → Execution + ECO + DMOCA

**版本：** V2.0  
**文档角色：** Goal/TDL/ECO 目标架构设计；当前实现状态见 [STATUS](../implementation/STATUS.md)。<br>
**原则：** 复用现有 Orchestrator / Journal / GDC / TDL / DMOCA / ContextManager；不另建 Runtime。

## 四个核心业务层

| 层 | 职责 | 权威落点 |
| --- | --- | --- |
| L0 Goal | 用户目标、成功标准、约束、目标版本 | `goal.fit` / GDC 投影 |
| L1 TDL | L0–L3 任务树、依赖、验收、真实进度 | `work.*` 事件 |
| L2 Cycle | 分析→设计→辩论→计划→实现→审核→结论 | `cycle.snapshot` + GDC |
| L3 Execution | 模型/工具/插件实际执行 | Orchestrator + Provider |

## 两个横向机制

| 机制 | 职责 | 边界 |
| --- | --- | --- |
| **ECO** | 工程上下文包、充分度、事实分类、补充请求 | 不调度任务、不定角色 |
| **DMOCA** | 动态选模、角色、贡献对齐、按需辩论审核 | 不认证工程事实真伪 |

长任务管理（持久化 / 压缩 / 检查点 / 恢复）为跨层基础设施，复用 `main/context/`。

## 关系

```
User Request → Goal → TDL → Cycle → Execution
                 ↑              |
                 +-- 回退/重规划 +
横向：ECO（能否正确参与）∥ DMOCA（谁参与、交什么）∥ LT（状态可恢复）
```

## 不可妥协

1. 进度来自事件与验收证据，不来自模型自报。
2. 旁听不等于具备正式架构裁决资格——须 ECO 充分度。
3. 正式决策引用固定贡献快照与上下文版本。
4. 禁止第二套 Runtime / Journal / Verifier / 权限系统。
