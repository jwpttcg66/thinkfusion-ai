# 增量复用安全修复

- 日期：2026-11-14
- 文件：`scripts/regression/run-debate-regression.cjs`
- 纯函数：`scripts/regression/incremental.cjs`
- 单测：`scripts/check-debate-incremental.mjs`

## 1. 原问题

旧实现：

```js
const oldFingerprint =
  old?.fingerprint ??
  (old ? fingerprint(entry.item, standardItem) : null);
```

当旧结果没有 `fingerprint` 时，代码直接用**当前配置**反算一个指纹，再把它
当成旧结果的指纹。旧结果并没有记录当时的 prompt 版本、runner 版本、标准
和模型池，所以无法证明它与当前配置一致。

实际严格基线中 9 道被复用的通过题**全部没有原始 fingerprint**。这 9 道
复用不能证明配置一致。

## 2. 修复

新增 `incremental.cjs`：

```js
function canReuseResult(oldResult, currentFingerprint) {
  return Boolean(
    oldResult &&
    typeof oldResult.fingerprint === 'string' &&
    oldResult.fingerprint.length > 0 &&
    oldResult.fingerprint === currentFingerprint &&
    oldResult.debate?.outcome === 'COMPLETED' &&
    oldResult.standard?.passed === true
  );
}
```

规则：

- 旧结果没有 `fingerprint`：一律重跑；
- 指纹为空：重跑；
- 指纹不一致：重跑；
- 执行不是 `COMPLETED`：重跑；
- V1 未通过：重跑；
- 只有 `fingerprint` 一致 + `COMPLETED` + V1 通过才复用。

不能再用当前配置反算历史指纹。

## 3. 单测

`npm run test:debate-incremental` 覆盖：

1. 没有 fingerprint 不能复用；
2. 空 fingerprint 不能复用；
3. prompt 变化必须重跑；
4. 模型池变化必须重跑；
5. 题目标准变化只让对应题失效；
6. 完成但 V1 失败必须重跑；
7. 未完成必须重跑；
8. 完成 + V1 通过 + 指纹一致才复用；
9. 完整性复核开关变化必须重跑；
10. 指纹不一致不能复用。

10/10 通过（含“完整性复核开关变化必须重跑”）。

## 4. 旧复用结果处理

严格增量结果中有 9 道复用题的指纹是旧逻辑回填的，不能信。已单独重跑：

- tcp-udp
- btree-index
- csrf-xss
- cache-invalidation
- feature-flag
- rate-limit
- observability
- testing-pyramid
- git-rebase

重跑结果：9/9 COMPLETED，9/9 V1 通过，平均分 100。

合并后：

- 24/24 COMPLETED；
- V1 16/24 passed / 8 failed；
- 24 题全部带有真实执行产生的 fingerprint；
- 不再有 `reused: true` 的回填结果。

可信明细：`docs/implementation/regression/debate-regression-v1-1-trusted-latest.json`。
