# 原生研究契约 v1

## 2026-11-11 生效补充：项目计划文档

本节优先于下方数据库目标/步骤数组的正式计划定义。消息接受 `research_mode: quick | deep`（省略为 quick），随用户消息持久化。首页首条消息和命令队列保留提交时模式。深度研究通过现有模型回合调查问题并生成文件，模型需说明无法验证的来源；提示词不构成训练授权。

正式计划正文唯一权威为 `<project.local_root>/research/plans/<conversation_id>/<id>.md`。首行 HTML 注释存储身份、标题、revision、last_request_id、updated_at；其后为 Markdown。SQLite 仅解析现有项目/会话作用域，不复制正文。旧研究记录/API保留兼容，不作为新计划默认写入目标。

- `research_document_list/read/write` 由 Backend 从当前原生回合绑定项目与会话，模型不能传入任意根目录。创建以 request_id 为文档身份；修改携带 id、唯一 request_id、expected_hash、完整 title/markdown。重复请求返回同一内容；旧 hash 或重复请求的不同正文拒绝覆盖。
- 更新前归档旧文件至同目录 `.history/<id>-<sha256>.md`；写临时文件、同步后替换目标。外部已发生的编辑通过内容摘要检测；不宣称对不配合锁定的外部编辑器提供跨进程事务。
- `GET /api/v1/projects/:project/research-documents?conversation_id=:conversation` 列出元数据；`GET .../:id?conversation_id=...` 每次读取实际文件正文及 sha256。路径须在项目内，拒绝非法身份、符号链接、无效文件头和超限文件；读取失败明确显示错误。
- 工作台复用现有 Preview 展开只读 Markdown；后续修改通过会话，外部编辑可保留文件头后修改正文。当前列表按来源会话隔离，上限 200 条。旧会话首次升级文档工具保留应用历史及原生会话引用，并传入有界上下文。

执行、预算强制控制、远端算力提交和结果回流仍属于 A2–A4，未因文档落盘而完成。

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

create/update 工具要求非空 plan；list/get 返回持久数据。保存研究目标不会触发训练。2026-11-11 本地阶段另行开放实验/Run 工具，见下方实现补充；内存 research.updated 事件不承担可靠结果投递。

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

## 2026-11-11 本地 Run 实现补充（当前实际接口）

上述 queued/reconciling 是后续目标状态模型。本次本地实现为 `prepared → preparing → running → succeeded/failed`，取消为 `cancelling → cancelled`，无法核对 wrapper 为 `unknown`。prepared 取消无需进程回执。终态状态和通知在同一事务保存；source/argv/plan 固定后才能批准。

数据库 v4 新增 experiments/runs/run_events/run_notices，升级前保存 metadata.pre-runs-v3.sqlite。计划正文仍由项目 Markdown 文件管理；Run 只保留提交时的不可变计划快照。

接口使用 `/api/v1/projects/{project}/experiments`、`/runs`，显式 conversation_id；runs/{id} 提供 approve、cancel、evidence、artifact，runs/events 提供持久活动。没有复用旧 research-session Run 路由。approve 必须提供固定 spec_hash，且重新核验源码；全局只允许一个 preparing/running/cancelling/unknown 本地 Run。

动态工具新增 research_skill_list/read、experiment_create/list、run_prepare/list/get/evidence/cancel。项目和来源会话由活动回合解析，模型不能指定另一身份，也没有批准启动工具。结果通知通过原 ChatHost 的稳定 loading_id 接受去重；busy 时等待，删除会话标记 conversation_deleted，不宣称外部调用 exactly-once。

成功退出与证据就绪独立：成功但没有有效 evaluate 指标标记 incomplete，通知明确说明限制。错误/取消也回传实际回执供诊断。内部 wrapper 异常不伪造退出状态，未知任务保留槽位。

系统提示词、9 个内置技能和只读文献 MCP 随 Backend 注册，资源版本 4。MCP 设置列表表示 configured，不冒充实时 connected。暂不提供 Agentic 自动启动或 SSH 训练。实现、限制及真实验证记录见 [阶段验收](../reports/desktop/research-workflow-implementation.md)。

### 固定评估协议与比较增量

当前资源版本升级为 5。新动态 run_prepare 要求 evaluation（dataset/dataset_version/split/evaluator_sha256/metric/direction/seed），原 HTTP 客户端仍可创建无协议 Run，但不可比较。协议摘要纳入 spec_hash，评估器文件摘要必须存在于快照清单。同实验不可更改协议。

Wrapper 注入评估协议及 hash；指定的 evaluate 指标必须带匹配身份，最大 step 必须唯一，才满足成功运行的证据条件。`run_compare` 及 `POST /projects/{id}/runs/compare` 从两次真实证据比较相同协议和目标，返回 comparable、原因或指标/差值/方向。仅为声明一致的单次运行比较，不证明数据使用正确，不自动晋级。旧记录不回填协议。详情见 [比较验收](../reports/desktop/research-comparison-implementation.md)。

### 暂停与结果通知恢复增量

当前 schema v5、工具/技能版本 6。新增项目/来源会话 research_controls 与独立 run_notice_delivery；v4 升级前备份。GET/PUT `/projects/{id}/research-control?conversation_id=...` 使用 expected_revision 更新 paused。新训练启动和后台通知输入受理各自同事务校验暂停；已启动 Run 与已受理回合继续。准备、读取、取消及用户直接聊天不受此暂停限制。

GET `/projects/{id}/run-notices` 查询通知状态，POST `/run-notices/{run}/retry` 仅重排 failed。最多 5 次发送尝试，指数退避；busy/paused 不扣失败次数；原始请求正文与稳定输入 ID 不变。accepted 不代表分析成功，不自动重放。删除会话的待处理通知停止投递。新增只读 research_control_get，模型无解除暂停能力。详情见 [控制阶段验收](../reports/desktop/research-control-implementation.md)。
