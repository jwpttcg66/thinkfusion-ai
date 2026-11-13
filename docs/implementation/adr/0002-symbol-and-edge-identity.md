# ADR-0002：符号身份与边模型

- 状态：Proposed
- 日期：2026-11-12
- 适用：Gate 1 / Gate 3

## 背景

当前模型无法承载 Java/Go/Python 的符号关系：

- `codeNodeId()` 含 `filePath`，文件移动即换 ID；
- 重载方法同文件同名同 kind 会合并；
- `CodeNodeType` 没有 `Enum` / `Annotation` / `Record` / `Constructor` / `Field` / `Parameter`；
- `CodeEdge` 没有 `resolutionStatus`，无法表达 `resolved/ambiguous/unresolved/dynamic/inferred`；
- `codeEdgeId()` 只含 source/target/relation，多候选调用会互相覆盖；
- `symbolKey` 不含模块和签名，Code-Memory Link 会错位；
- 边只按源文件删除，跨文件删除会留下悬空边。

## 决策

### 符号身份

```
symbolId = sha256(
  language | moduleId | packageName | ownerChain |
  name | normalizedParameterTypes | nodeType
)
```

规则：

- `moduleId`：Maven/Gradle 模块；普通工程用相对根路径或 `root`。
- `packageName`：Java 必须有 package；当前 `collectJava()` 没有，Gate 1 补。
- `ownerChain`：`Outer.Inner`；匿名类/局部类用 `ownerChain + enclosingMethod + 源码区间`。
- `normalizedParameterTypes`：只对方法/构造器；返回类型不参与 Java 重载键。
- `nodeType`：区分 `Class/Interface/Enum/Annotation/Record/Constructor/Method/Field/Parameter`。
- `locator` 单独存：`filePath + startLine + endLine + generation`。
- `fingerprint` 单独存：符号内容 hash；文件移动不改 ID，改 locator；重命名产生新 ID，旧链接走 `needs_relink`。

### 边

```
CodeEdge {
  projectId
  edgeId
  sourceNodeId
  targetNodeId?          // unresolved 时为空
  relationType           // 联合类型，不是任意 string
  resolutionStatus       // resolved | ambiguous | unresolved | dynamic | inferred
  source                 // JDT | TREE_SITTER | LSP | AST | STATIC_ANALYSIS | CGC | MANUAL
  callSiteId?            // 同一调用点的候选共享
  evidenceRefs: string[]
  filePath / line        // 调用点定位
  generation
}
```

规则：

- `resolved`：目标符号身份唯一，且来源/调用点可复核。
- `ambiguous`：同一调用点有多个候选；写多条边，共享 `callSiteId`。
- `unresolved`：知道有关系但目标未知；`targetNodeId` 为空。
- `dynamic`：反射/动态代理/运行时注入；不得伪造目标。
- `inferred`：模型推断；不得与源码确认的关系混在一起。
- 唯一键包含 `source + target? + relation + callSite + generation`。
- 查询策略：默认只取 `resolved` / `source-confirmed`；`ambiguous/inferred` 作为候选展示，不进入“确定调用方/确定影响”。

## 迁移

- 新增 `symbol_id` 列；旧 TS/JS 节点用现有 `node_id` 作为临时 `symbol_id`，避免破坏现有查询。
- Java 新节点直接使用新规则。
- `code_memory_link.symbol_key` 迁移到新 symbolId；无法确认的置 `needs_relink`。
- 旧边 `resolution_status` 回填：目标存在则 `resolved`，否则 `unresolved`。

## 验收

- 文件移动：symbolId 不变，locator 更新。
- 重载方法：两个不同 symbolId；调用点能分别指向。
- 多模块同名类：moduleId 区分。
- 匿名类：区间变化后 link 为 `needs_relink`，不自动绑新类。
- 删除目标：入边清理或 `unresolved`，无悬空边。
