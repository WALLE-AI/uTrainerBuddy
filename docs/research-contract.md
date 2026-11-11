# 原生研究契约 v1

状态：R0 接口设计基线；首批研究目标创建、列表、详情、编辑接口已实现，并通过真实 HTTP 与进程重启测试。其余为后续 R2/R3 契约，尚未实现；Run 提交当前返回 501，不返回假成功。

## 对象与所有权

Rust Backend 与现有 metadata.sqlite 是唯一持久状态写入方。桌面及 Agent 使用同一 API，不直接写库、不启动上游服务。现有 conversation plan 消息是 Agent 临时步骤，不替代研究目标。

| 对象 | 身份与关联 | 生命周期及约束 |
| --- | --- | --- |
| Project | 复用 projects.id | 项目隔离边界；不从路径推导身份 |
| ResearchSession | id、project_id、origin_conversation_id | 一个项目可有多个目标；每个目标记录发起会话。目标文本、评测说明、约束和 revision 可修改；不能跨项目改绑 |
| Experiment | id、research_id、parent_experiment_id（可空） | baseline 为根；候选引用同一研究的父实验，禁止循环和跨研究引用 |
| Run | id、experiment_id、attempt、request_id | 一次执行一个身份；重试创建新 Run 并关联原 Run，不覆盖旧证据 |
| SourceSnapshot | 复用 source_snapshots 的固定快照能力 | Run 保存内容摘要与实际路径、commit；只有发布记录不等于已具备本地执行快照 |
| ExecutionTarget | 引用 compute_targets.id 或显式 local 类型 | Run 固定目标身份/绑定 revision/目录映射/检查时间，禁止跟随当前活动连接变化；不存密码、私钥、临时 token |
| Artifact | id、run_id、kind、相对路径、摘要、size | Backend 验证处于该 Run 的产物目录，沿用 Preview；缺失指标为 null，不补零 |
| ResearchEvent | 单调 seq、project_id、research_id、kind、对象 ID、时间 | 与状态事务一同提交；重启可按游标补读，不用聊天消息作为事件库 |

会话删除后保留研究目标与证据：origin_conversation_id 保留为历史来源字符串；创建时必须核验会话属于该项目。项目有研究记录时不允许硬删除。目标编辑不回写历史 Run 的目标/评测快照。

## 工作台作用域

- 查询始终带 project_id。默认以当前会话过滤研究目标；固定来源时使用固定会话。项目切换清除固定来源和选中研究/Run；旧请求返回不能覆盖新作用域。
- 一个会话存在多个目标时显式选择 research_id；不隐式取“最近一个”并提交。
- 「计划」展示研究目标/评测/约束与现有 Agent 步骤；「运行」承载实验树、Run 详情及比较；「产物」读取所选研究的证据；「动态」读取持久事件；「文件」复用 ProjectFiles/ProjectPublish 和 Preview。
- 跨来源卡片定位需先提示切换固定来源。引用追加到当前会话草稿，携带来源 ID，不自动发送。收起面板不停止执行。

## HTTP 约定

复用现有实例 Bearer 认证、Origin 校验和 `/api/v1` 路由。成功返回 `{data: ...}`；错误返回现有 `{code,message}` 结构。时间为 Unix 毫秒。项目下不存在的对象返回 404，避免泄漏其他项目对象；校验失败 400；幂等键内容冲突和 revision 冲突 409。

| 标签/动作 | 端点（均在 /api/v1 下） | 请求与响应 |
| --- | --- | --- |
| 计划列表 | GET projects/:project/research?conversation_id=... | 返回目标数组，按创建时间倒序；可选来源过滤，最多 200 条，后续分页另行版本化 |
| 创建目标 | POST projects/:project/research | `{request_id,origin_conversation_id,title,objective,evaluation,constraints}` → ResearchSession；request_id 项目内唯一，同内容返回原目标，不同内容 409 |
| 目标详情 | GET projects/:project/research/:research | ResearchSession；路径项目和目标必须匹配 |
| 编辑目标 | PATCH projects/:project/research/:research | `{expected_revision,title,objective,evaluation,constraints}` 全量替换可编辑字段；revision 原子递增；不修改来源或已有 Run |
| 实验 | GET/POST projects/:project/research/:research/experiments | 查询/创建父子实验，创建使用 request_id |
| 运行 | GET/POST projects/:project/research/:research/runs | 查询/提交；提交携带 experiment_id、固定 snapshot/target/check IDs、argv、资源/预算与 request_id；Backend 重新检查，不能只信 UI |
| Run 详情/取消 | GET .../runs/:run；POST .../runs/:run/cancel | 详情包含阶段、观测时间、exit_code、执行器 handle；取消返回实际持久状态，不能先报 cancelled |
| 日志 | GET .../runs/:run/logs?after=... | 分页 offset、截断信息和内容；只读固定 Run 日志目录 |
| 产物 | GET .../artifacts?run_id=... | 持久产物元数据；打开需校验 scope/path，不接受任意绝对路径 |
| 动态 | GET .../events?after=seq&limit=... | 升序事件、next_cursor；推送仅用于唤醒补读，可靠性来自持久游标 |
| 文件/算力 | 已有 compute-binding、snapshot-preview、publish、transfers、compute/target | 复用现有接口，不新增凭据 CRUD |

ResearchSession 首批字段：`id, project_id, origin_conversation_id, title, objective, evaluation, constraints, revision, created_at, updated_at`。title 1–200 字符，objective 1–16000，evaluation/constraints 各最多 16000，request_id 1–128。首批不接受未知字段，避免调用者误以为提交了预算或执行参数。

2026-11-11 A1 扩展：新增 `plan: string[]`，最多 30 步，每步 1–2000 字符。旧记录缺省为空；创建可省略，修改省略时保留现有计划。计划是研究意图，不是 Agent 临时任务进度或真实 Run 状态。用户从会话提出需求，智能体负责生成/保存；手动编辑仅作辅助。

## 已实现的会话研究工具

通过 Codex App Server 的动态工具注册 `research_list/get/create/update`。模型不接收 HTTP token，不允许提供 project_id 或 origin_conversation_id；后端从当前 ActiveTurn 对应的 conversation 解析身份，get/update 还校验目标属于该来源会话。调用必须匹配当前 native thread/turn 且尚未取消。未知参数/工具及过期调用返回失败。所有写操作复用上面的 research dispatch/事务/revision/幂等规则，模型收到实际 ID 和版本后才能报告保存成功。

create/update 工具要求非空 plan；list/get 返回持久数据。结果不会触发训练；Run 工具尚未开放。工具变化发布 research.updated 事件，当前工作台通过来源隔离的 3 秒可见轮询自动刷新，未把内存通知当作未来的可靠结果 outbox。

本机 Codex 0.167.0 导出 schema 支持 thread/start.dynamicTools，thread/resume 没有补装字段；已有工具随原生线程持久化。旧应用会话首次启用工具时新建原生线程，原线程 ID 保存为 previous_native_thread，应用聊天记录不删；迁移传入最近 20 条文本、每条最多 2000 字符的历史数据，并显示升级提示。之后恢复同一工具线程，启动/恢复均更新研究指令。此处是明确的一次迁移，不宣称完整原生上下文无损。

协议依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental) 与本机 `app-server generate-json-schema --experimental` 的 DynamicToolSpec / DynamicToolCallParams / DynamicToolCallResponse。实验性协议变化需重新验收；适配失败不能降级为虚假的保存成功。

## Run 状态与执行边界

`queued → preparing → running → succeeded | failed`；未派发 queued 可以直接 cancelled。已派发/正在运行的取消进入 cancelling，只有执行器确认进程终止才能进入 cancelled；自然完成与取消竞争按执行器证据收敛，不能伪造退出码。

状态变化使用 revision/CAS 并在同一事务写事件。终态不可逆；失败重试创建新 Run。阶段字段单独记录 setup/train/evaluate，不从日志文字推断终态。

断连或 Backend 重启时，无法确认的活跃 Run 进入 reconciling，保留 last_known_state、handle 和 observed_at；重新查询原 handle 收敛到运行/终态。无法接回则 unknown，明确需要人工处理；不能自动重提。资源占用不得仅凭断连释放。取消超时保留 cancelling/reconciling，不报取消成功。

提交的幂等记录与 Run 创建原子写入；执行器需接受稳定 run_id 及启动回执，防止“已启动但回执丢失”造成双跑。预检查失败不启动进程，记录可读错误；连接可达不等于数据/依赖/GPU 就绪。

暂停研究阻止新提交；停止 Agent 仅影响会话；取消 Run 只针对该运行。预算、目标选择、授权最终由 Backend 检查。首批研究目标 API 不包含这些尚未实现的执行操作。

## 存储与迁移

在现有数据库中新增 research_sessions 和 research_requests，schema 升至 v3；v1/v2 升级前备份，DDL 与版本更新事务化。研究表引用 projects；来源会话不使用级联删除外键。更新使用 revision 防止界面/Agent 相互覆盖。请求记录保存首次创建的请求和响应，重放返回首次结果，不覆盖后续编辑。

后续 experiments/runs/artifacts/events 分阶段迁移，各阶段需覆盖事务回滚、项目隔离、重启与重复提交。旧 `.data/research-gateway*` 数据只读保留，首批不导入；禁止直接写入旧库或按名字自动合并。导入需独立映射与回执，旧版本 Backend 遇新 schema 应拒绝启动，不能静默降级。

现有 Host 发布与远端文件 RPC 不等于研究执行器。R3 先接本地受控子进程（独立 Run 目录、argv、日志文件、退出码、进程组），再扩展 SSH 持久 handle 和恢复。普通进程退出验证不能冒充真实 GPU 训练验收。
