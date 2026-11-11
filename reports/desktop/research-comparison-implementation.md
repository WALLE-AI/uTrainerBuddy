# 固定评估协议与候选比较实施记录

日期：2026-11-11。承接本地 Run 阶段，完成 P2 中的同协议比较、桌面展示和真实 Agent 决策验证。本文记录比较阶段；后续研究暂停/重试管理已交付，见 [控制阶段记录](research-control-implementation.md)。远端 GPU 与自动预算授权仍未完成。

## 实现

Run 新增固定 evaluation：dataset、dataset_version、split、evaluator_sha256、metric、direction（maximize/minimize）、seed。协议计算 evaluation_hash，并与计划、代码、命令一起纳入原 spec_hash。评估器摘要必须匹配提交快照中的一个文件，不能填一个格式正确但无来源的摘要。同一实验的协议不可改，修改需新建子实验。

动态工具 run_prepare 必须提供 evaluation；HTTP 保留无协议的历史客户端兼容。旧 Run 不回填猜测的协议，也不能参与比较。无需数据库 DDL 迁移，仍为 schema v4；工具/提示词/技能 bundle 升至版本 5，沿用旧线程重新注册机制。

Wrapper 传入 TRAINERBUDDY_EVALUATION_SPEC/HASH。指定的 evaluate 指标必须带匹配的 evaluation_hash 和 run_id；最终值取该指标最大 step 的唯一记录。缺失、身份不符、重复最终记录均不视为完整评估证据。

新增 `POST /api/v1/projects/{project}/runs/compare?conversation_id=...` 和动态工具 `run_compare`，参数 baseline_run_id/candidate_run_id。后端读取实际 Run/指标，检查来源隔离、协议、执行目标、成功状态与证据。不可比较返回 comparable=false 及原因，不计算排名；兼容时返回实测值、差值、方向修正后的 improvement、两次 Run ID 与提交。

“运行”页当前运行作为候选，可选择另一运行作基线；展示指标、差值、改善/退步/持平及比较限制。协议不一致、证据未就绪及旧记录缺少协议显示明确原因。批准前显示固定协议的主要字段；同时修复已有研究运行中文文案问号乱码。buddy-run/results 技能同步更新。

## 验收证据

- Rust 14 项通过；Clippy `--all-targets -- -D warnings`、TypeScript、构建及原聊天协议回归通过。
- `node backend/scripts/test-runs.mjs --ui`：真实本地基线/候选训练，独立评估器、快照保护、不同协议/旧协议拒绝、跨会话拒绝；隐藏 Electron 验证真实比较组件和不可比提示。另保持恢复、取消、超时和指标缺失回归。
- `node backend/scripts/test-research-loop.mjs`：真实模型按技能准备 baseline、用户测试驱动明确批准；测试驱动提交候选、明确批准；原 Agent 收到结果并调用真实 run_compare，给出基于实际证据的决定。候选代码由测试驱动创建，不能把此验收描述成 Agent 自动生成/提交候选。
- 真实 Agent 证据：`backend/test-data/live-loop-6yws4k`。基线 Run `ab2bfe8b-7714-49e4-a833-5a3392564d54` 为 0.975；候选 Run `2ee09525-260b-4b76-9c79-c0f599df9755` 为 0.950。候选降低学习率，其他评估条件相同。Agent 正确判断低 2.5 个百分点，建议停止该候选、保留基线，并声明单一种子限制。
- 界面截图：`reports/desktop/research-comparison.png`。这是组件验收截图，不是整个打包应用的端到端截图。
- 最终接口及桌面回归证据：`backend/test-data/run-engine-q5MdB6`，包含评估器摘要不存在、不同协议、旧协议缺失与跨会话拒绝检查。

## 边界

协议兼容是结构化声明和证据身份核对，不独立证明程序实际使用了所声明的数据、调用了指定评估器或没有数据泄露。当前评估器是快照中的文件；其外部依赖、环境锁、数据物理资产校验尚未覆盖。比较为单次运行，不能自动得出统计显著或全局最优结论。跨种子聚合、独立测试集验收、正式晋级记录及自动启动仍待实现。

研究暂停/通知重试已在后续阶段交付。下一阶段需补资产/环境契约，再扩展远端持久执行。GPU 实测需要明确服务器、模型、数据和预算。
