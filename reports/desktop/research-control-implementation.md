# 研究暂停与结果通知恢复实施记录

日期：2026-11-11。接续固定评估与候选比较，交付 P2 的暂停、通知退避重试、人工恢复及界面状态。

## 实际行为

- 每个项目的来源会话独立保存 paused/revision/updated_at。暂停阻止新的训练启动和自动结果通知受理；不会停止已启动训练、已受理分析回合，也不会禁用用户直接聊天、准备快照、阅读证据或取消运行。
- 暂停更新使用 expected_revision 防止旧界面覆盖新状态。训练启动、通知受理都在各自写入事务中检查暂停状态；并发顺序由事务决定。若启动/受理先于暂停提交，该任务继续，不伪装成已停止。
- 通知元数据与原始通知正文分开存储，重试保持同一个 loading_id 和请求内容。会话繁忙或研究暂停不消耗失败次数；它们保留原通知，恢复后继续。
- 非繁忙/暂停的发送错误最多尝试 5 次，失败间隔约 1/2/4/8 秒（另加后台扫描时间）；达到上限标记 failed，保留错误。用户可手动重新排队，再获得一轮有限次数的投递。
- accepted 只表示会话已受理输入，不表示模型成功分析。已受理结果不因后续模型失败、回合取消或 Backend 重启自动重发。需要重新分析时用户在原会话明确提出；“重试结果通知”不重跑训练、不重放已受理消息。
- 已删除会话的待投递/失败通知标记 conversation_deleted，包括删除前处于暂停状态的会话；不投到其他会话。
- 已受理输入但尚未保存 outbox accepted 状态时崩溃，恢复依靠现有 inputs 稳定 ID 去重收敛；不声称模型或外部工具调用 exactly-once。

## 接口与存储

均使用既有 Backend 鉴权。conversation_id 必须在查询参数明确提供，并校验其属于项目。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/v1/projects/{id}/research-control` | 读取暂停状态；无记录默认为未暂停、revision 0 |
| PUT | 同上 | `{paused, expected_revision}`；冲突或暂停启动返回 HTTP 409 |
| GET | `/api/v1/projects/{id}/run-notices` | 当前来源通知及 attempts/next_attempt_at/last_error/accepted_at，最多 200 条 |
| POST | `/api/v1/projects/{id}/run-notices/{run}/retry` | 只将 failed 重新排队；pending/accepted 不重复排队 |

模型新增只读 research_control_get，没有暂停解除工具。buddy-run 指南同步解释控制边界；工具/技能 bundle 版本 6。SQLite schema 升为 v5，新增 research_controls/run_notice_delivery，v4 升级前备份 metadata.pre-control-v4.sqlite；旧版 Backend 拒绝打开新版本库。

“运行/产物/动态”视图显示当前研究暂停状态；暂停时禁用启动按钮。选定 Run 展示通知状态、尝试次数、错误及下次尝试时间，失败时提供“重试结果通知”。暂停下手动重试只恢复排队，仍需用户恢复研究后才投递。

## 验证

- Rust 16 项测试：包含暂停与通知受理同事务拒绝、拒绝时消息/inputs 不落库、暂停下用户消息仍可受理、状态 revision 冲突、v4 备份升级保留旧通知、重试错误不改变原始通知正文。
- `node backend/scripts/test-runs.mjs --control --ui`：真实 CPU 训练、暂停下启动拒绝、状态跨重启、运行中暂停不影响完成、暂停下通知保留、故意移除测试 Codex 路径触发 5 次发送失败、界面手动重试、恢复环境后一次受理、注入 outbox 确认丢失后恢复去重、暂停后删除会话。
- 隐藏 Electron 验证实际 React 组件与 Backend，包括暂停按钮、刷新后暂停保留、启动按钮禁用、通知状态与手动重试。组件验收不等同于完整打包应用 E2E。
- 原聊天协议回归、TypeScript、Clippy 和构建均通过；真实 Agent 闭环也通过，实际调用 research_control_get，并完成结果回读和比较。
- 最终完整接口/界面/失败恢复证据：`backend/test-data/run-engine-dNd6tt`；真实模型证据：`backend/test-data/live-loop-cCmWU5`；界面截图：`reports/desktop/research-control.png`。

## 后续范围

仍未实现远端 GPU 持久执行、模型/数据资产校验、环境锁、自动候选提交和预算硬限制。此阶段控制的是受管 Run 与自动通知；通用 shell 仍沿用原生审批边界，不能把暂停描述为全局进程防火墙。
