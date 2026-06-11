# Deep Interview Spec: RSS XML Parse Error Handling

**Created**: 2026-06-11T15:16:00Z
**Slug**: rss-xml-parse-error
**Profile**: Standard
**Final Ambiguity**: 15.5%
**Threshold**: 20%
**Context Type**: Brownfield

---

## Context Snapshot Reference
- Path: `.omx/context/rss-xml-parse-error-20260611T151600Z.md`
- Summary: RSS parser throws "Unable to parse XML" when Nitter instance returns non-XML content

---

## Clarity Breakdown

| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Intent | 0.90 | 0.25 | 0.225 |
| Outcome | 0.90 | 0.20 | 0.180 |
| Scope | 0.85 | 0.20 | 0.170 |
| Constraints | 0.80 | 0.15 | 0.120 |
| Success | 0.80 | 0.10 | 0.080 |
| Context | 0.70 | 0.10 | 0.070 |
| **Total** | | | **0.845** |

**Ambiguity**: 1 - 0.845 = **0.155** (15.5%)

---

## Intent (为什么做)
用户希望改进 RSS 推送系统的错误处理机制，使其在 RSS 源获取失败时能够优雅地处理错误，而不是记录错误日志后继续执行。

---

## Desired Outcome (期望结果)
1. RSS 源获取失败时，跳过该任务并通知用户
2. 支持多种错误类型：XML 解析错误、网络超时、HTTP 错误、内容为空
3. 使用延迟通知策略：失败后等待再试，仍然失败才通知
4. 单个任务失败不影响其他任务执行
5. 同一个失败任务不会重复通知

---

## In-Scope (修改范围)
1. **错误类型处理**
   - XML 解析错误 (`Unable to parse XML`)
   - 网络超时 (`timeout`)
   - HTTP 错误 (`4xx/5xx`)
   - 内容为空 (`empty-content`)

2. **重试机制**
   - 延迟通知策略：失败后等待 N 秒，再次尝试
   - 如果仍然失败，才发送通知
   - 可自行决定重试间隔（建议：5-10 秒）

3. **通知机制**
   - 失败时通过 DingTalk webhook 发送通知
   - 通知消息模板可自行决定
   - 避免重复通知

4. **错误日志**
   - 记录详细的错误信息
   - 错误日志格式可自行决定

---

## Out-of-Scope / Non-goals (非目标)
1. ❌ 不修改现有的 DingTalk 通知格式
2. ❌ 不修改成功时的处理逻辑
3. ❌ 不引入新的 npm 依赖包
4. ❌ 不改变现有的 API 接口和数据结构

---

## Decision Boundaries (决策边界)
以下决策可自行决定：
- 错误日志的输出格式和内容
- 重试的等待时间（建议 5-10 秒）
- 失败通知的消息内容模板
- 如何分类不同类型的错误

---

## Constraints (约束条件)
1. 使用现有的 `rss-parser` 库
2. 使用现有的 DingTalk webhook 通知系统
3. 不引入新的依赖
4. 保持代码简洁，易于维护

---

## Testable Acceptance Criteria (可测试验收标准)

### AC1: 错误处理
- [ ] 当 RSS 源返回 XML 解析错误时，任务被跳过
- [ ] 当 RSS 源网络超时时，任务被跳过
- [ ] 当 RSS 源返回 HTTP 错误时，任务被跳过
- [ ] 当 RSS 源返回空内容时，任务被跳过

### AC2: 重试机制
- [ ] 失败后等待 N 秒（建议 5-10 秒）再重试
- [ ] 重试仍然失败时，才发送通知
- [ ] 重试成功时，不发送通知，继续正常处理

### AC3: 通知机制
- [ ] 失败时通过 DingTalk webhook 发送通知
- [ ] 通知包含任务名称、错误类型、错误信息
- [ ] 同一个任务在短时间内不会重复通知

### AC4: 任务隔离
- [ ] 单个任务失败不影响其他任务的执行
- [ ] 任务继续执行，不会因为一个失败而停止

### AC5: 错误日志
- [ ] 错误信息记录到错误日志文件
- [ ] 日志包含时间戳、任务名称、错误类型、错误详情

---

## Assumptions Exposed (暴露的假设)

### Assumption 1: Nitter 实例可能临时不可用
- **Evidence**: 错误日志显示多次 "Unable to parse XML" 错误
- **Resolution**: 使用延迟通知策略，避免临时故障导致的大量通知

### Assumption 2: 用户希望避免重复通知
- **Evidence**: 用户选择 "no-repeat" 作为成功标准
- **Resolution**: 实现去重机制，同一个任务在短时间内不会重复通知

### Assumption 3: 现有通知系统足够
- **Evidence**: 代码库已配置 DingTalk webhook
- **Resolution**: 使用现有通知系统，不引入新依赖

---

## Pressure-Pass Findings (压力测试发现)

### Round 3 → Round 7 深化
- **Original**: retry-1（重试 1 次）
- **Pressure Question**: 如果 Nitter 实例临时宕机 5-10 分钟，仅重试 1 次可能导致所有任务都失败并发送通知
- **Revised**: delay-notify（延迟通知策略）
- **Impact**: 避免临时故障导致的大量通知，提供更好的用户体验

---

## Technical Context (技术上下文)

### 代码库现状
- **RSS 解析**: 使用 `rss-parser@^3.12.0` 库
- **错误处理**: `taskProcessor.js` 中已有 try-catch 错误处理
- **通知系统**: 已配置 DingTalk webhook
- **代理支持**: 支持 HTTP/HTTPS 代理

### 需要修改的文件
1. `taskProcessor.js` - 主要修改文件，添加错误处理和重试逻辑
2. 可能需要修改 `cron.js`（如果保留旧版处理逻辑）

### 关键代码位置
- RSS 解析: `taskProcessor.js` 第 40-50 行
- 错误处理: `taskProcessor.js` 第 180-195 行
- 通知发送: `taskProcessor.js` 第 100-170 行

---

## Full Transcript Reference
- Path: `.omx/interviews/rss-xml-parse-error-20260611T151600Z.md`

---

**Spec Complete**
**Ready for Execution Handoff**
