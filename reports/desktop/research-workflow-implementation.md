# 研究与模型训练：本地阶段实施记录

日期：2026-11-11。对应《uTrainerBuddy研究与模型训练实施方案》第 14 节优先实施包。本次交付本地受控训练闭环，并提前接入 P2 的结果通知；不是 P0–P4 全部完成。后续增量见 [比较阶段验收](research-comparison-implementation.md) 和 [暂停/通知恢复验收](research-control-implementation.md)。下列版本 4 验证记录为首批历史记录，当前技能/工具版本为 6、schema v5。

## 已落地

- 系统提示词独立模板，Backend 注入实际项目、会话和能力；工具/提示词/技能资源版本为 4，旧线程重新注册工具。
- 9 个内置技能：literature、research-plan、reports、experiment-code、experiment-tree、run、run-evidence、results、figures。通过只读动态工具按需加载，发布不依赖 opensource 目录。来源 commit、文件摘要及 MIT 许可在 `backend/agent-resources/`。
- 原生 Codex 会话配置只读 alphaXiv MCP，开放 discover_papers、get_paper_content、answer_pdf_queries。设置接口返回配置事实；尚不提供通用 MCP 配置管理和实时连接状态持久化。
- SQLite v4 新增 experiments、runs、run_events、run_notices；迁移前备份。模型工具从活动回合绑定项目/会话身份。
- 实验独立 Git worktree；从干净提交生成快照。Run 固定计划内容及 hash、代码清单、argv、超时和本地目标，批准前重新核验源码和 spec hash。执行使用独立快照目录。
- UI 明确批准后启动；模型没有自批准工具。全局单个本地运行槽位。独立 wrapper、启动围栏、文件锁、退出回执，Backend 重启接回原 Run，不自动重跑状态未知任务。Windows 使用 Job Object 管理进程后代。
- 结构化 metrics.jsonl、分页日志、文本产物 Preview、运行事件；退出成功但没有有效评估指标时标记 evidence incomplete，不伪装实验结论。
- 持久通知在会话空闲后投递原会话，使用稳定输入 ID 去重；真实 Agent 已读取 Run 证据并报告实测指标。
- 现有运行/产物/动态标签页接入真实数据，保留聊天入口与 Markdown 计划源文件。

## 验证

| 类别 | 命令/证据 | 结果与边界 |
|---|---|---|
| Rust | `node backend/scripts/toolchain.mjs test` | 13 项通过 |
| 静态检查 | `node backend/scripts/toolchain.mjs clippy --all-targets -- -D warnings`；desktop `tsc --noEmit` | 通过 |
| 构建 | `node backend/scripts/toolchain.mjs build --examples --bins` | 通过 |
| 本地真实训练 | `node backend/scripts/test-runs.mjs` | 标准库逻辑回归实际优化权重；验证 accuracy > 0.9、隔离提交、幂等、源码篡改拒绝、重启恢复、取消、超时、指标缺失和会话隔离 |
| 桌面组件 | `node backend/scripts/test-runs.mjs --ui` | 隐藏 Electron 窗口操作真实 React 组件 + Backend：批准、训练、指标、产物 Preview、动态、会话隔离；不是整个打包应用 E2E |
| 桌面证据 | `backend/test-data/run-engine-QAGQxp`；`reports/desktop/research-runs.png` | UI 验收产物；测试目录被 Git 忽略 |
| 真实文献 Agent | `node backend/scripts/test-research-documents.mjs --live`；`backend/test-data/research-agent-XLCC5U` | 真实 skill 读取、MCP 检索/阅读及带来源计划落盘 |
| 真实训练 Agent | `node backend/scripts/test-research-loop.mjs`；`backend/test-data/live-loop-Jz93KN` | 真实 Agent 准备 Run → 显式 API 批准 → CPU 训练 → outbox → 原会话读取指标；没有用 shell 替代运行工具 |

样例是合成数据 CPU 分类器，不是大模型微调或 GPU 性能证明。其脚本在 `backend/recipes/cpu-classifier/train.py`。

## 使用

在绑定本地 Git 仓库的项目会话中提出研究目标，要求保存研究计划、创建实验并准备本地训练。Agent 使用 experiment_create 返回的 worktree 编辑并提交代码，再用 run_prepare 准备 Run。进入“运行”查看命令、超时、提交和固定计划，点击“批准此命令并启动”。完成后可查看指标、日志和产物，原会话收到结果并继续分析。

训练程序通过 TRAINERBUDDY_RUN_ID、TRAINERBUDDY_OUTPUT_DIR、TRAINERBUDDY_METRICS_FILE 获取输出位置。指标一行一个 JSON：schema_version=1、run_id、stage=setup/train/evaluate、metric、非负 step、有限数 value。至少一条有效 evaluate 指标才满足成功运行的最低证据条件。

## 尚未交付的范围

- P0 契约已增加固定 EvaluationSpec；独立 RunRecipe/AssetRef/ExecutionGrant 仍待扩展。当前用固定 spec 和显式单 Run 批准，不宣称完整研究协议。
- P2 的实验比较面板、同协议候选比较及真实 Agent 决策、研究暂停与通知重试管理均已在后续增量交付。已有结果回传不等于完整自主研究闭环。
- P3 远端持久训练 wrapper、SSH 恢复、GPU/数据/模型预检、checkpoint 回收尚未接入。已有文件 Host 不代表远程训练能力。实际验收需要指定 Linux GPU 服务器、模型、数据与安装许可。
- P4 预算授权、自动候选提交、目标/花费硬限制尚未实现；当前逐 Run 批准。通用 shell 保持原生审批机制，运行工具的约束不能描述成全局 shell 沙箱。
- 当前 Windows 本地流程实测；Unix 进程树生命周期未验收。内部 wrapper 错误无可靠退出回执时保留 unknown，需人工排查，不释放未知运行槽位并自动重提。
- 日志界面只展示首 64 KiB，工具可按 offset 继续读取；无轮转身份协议。指标最多 2 MiB/10000 条，产物列表首层最多 200 项，文本预览最多 1 MiB。大 checkpoint 暂不通过该预览读取。
- Git worktree 创建与 SQLite 无跨系统事务，崩溃可能留下孤立 worktree；不能把当前幂等接口宣称为 Git/DB 原子提交。

固定评估协议、候选比较、研究暂停与通知重试已推进；下一阶段补资产环境契约，再接指定远端。未完成项不得标记为已验收。
