# Codex MVP

保留 `frontend/desktop` 的页面和交互，通过 Rust Backend 接入原生 Codex：

```text
Electron / React → HTTP + WebSocket → Rust (Axum / Tokio / SQLite)
                                      → Codex app-server (stdio JSON-RPC)
```

首页发送后进入原有会话页；支持流式回复、继续对话、停止、历史持久化、原生线程恢复、工具/计划事件、权限确认和用户提问。`acp` 字段仅用于兼容现有前端 DTO，不代表把 Codex 协议转换成另一种智能体引擎。

## 启动

需要 Node、Bun、Codex CLI 和已有的 Codex 登录/提供商配置。Windows 编译需要 MSVC Build Tools。当前机器已安装项目本地 Rust 工具链。

```powershell
# 首次安装 Rust（工具链、下载与临时文件均在项目所在盘）
node backend/scripts/setup-rust.mjs

cd frontend/desktop
bun install
bun run electron:dev
```

`electron:dev` 先编译 Rust，再启动原有桌面。Electron 负责启动和关闭自己拥有的 Backend；Backend 负责 Codex 子进程。Windows 使用 Job Object 关闭子进程树。原生 Codex 的登录、模型和提供商配置沿用用户现有设置。

可选环境变量：`TRAINERBUDDY_CODEX_BIN` 指向原生 Codex 可执行文件，`TRAINERBUDDY_BACKEND_BIN` 指向 Backend，`TRAINERBUDDY_DATA_DIR` 和 `TRAINERBUDDY_DESKTOP_DATA_DIR` 分别指定后端与桌面数据目录。

## F 盘存储

本仓库位于 `F:\WALLE-AI\uTrainerBuddy`，项目脚本显式配置：

| 内容 | 目录 |
| --- | --- |
| Cargo 注册表、Git 依赖和下载缓存 | `.tools/rust/cargo` |
| Rust 工具链 | `.tools/rust/rustup` |
| 编译产物和增量缓存 | `backend/target` |
| 构建临时文件 | `.tools/tmp` |
| 开发后端数据库、工作区、诊断日志 | `.data/backend` |
| Electron 开发数据 | `.data/desktop` |

本机 Windows 用户级 `CARGO_HOME`、`RUSTUP_HOME` 也已设置为上面的 F 盘绝对路径，新终端生效。项目脚本立即生效，不依赖终端继承的旧变量。未修改系统 `HOME` 或用户的 Codex 配置/凭据目录。

## 验证

在仓库根目录执行：

```powershell
node backend/scripts/toolchain.mjs test
node backend/scripts/toolchain.mjs clippy --all-targets -- -D warnings
node backend/scripts/toolchain.mjs build --examples --bins
node backend/scripts/test-protocol.mjs
node backend/scripts/smoke-codex.mjs
```

`test-protocol.mjs` 使用单独编译的协议测试进程，覆盖计划/工具事件、允许/拒绝、过期请求、提问顺序、取消和崩溃恢复；不会用于桌面运行。`smoke-codex.mjs` 调用真实 Codex，验证鉴权、WebSocket、幂等发送、数据库历史和 Backend 重启后续接原生线程。测试数据在 `backend/test-data/`。

桌面端到端测试需以 `bun run electron:dev -- --remote-debugging-port=9223` 启动，然后在仓库根目录执行 `node frontend/desktop/scripts/verify-codex.mjs`。测试通过原有首页输入框发送真实消息，刷新并继续对话，保存 `reports/desktop/codex-mvp.png`，最后返回原页面。

## 当前边界

- 仅 Codex 已实现。Claude Code、OpenCode、DeepSeek Harness 在能力清单中声明为未实现。
- 使用本机原生 Codex 默认模型；模型发现、运行中切换模型和中途插话尚未接入。
- 会话、消息、设置保存在 SQLite；原生线程 ID 用于 Codex `thread/resume`。异常中断明确提示交付状态可能不明，不自动重发。
- 本地文件引用会附加到输入；上传附件、临时技能注入、跨会话引用会明确返回不支持。
- 已接入 SSH 算力连接与资源探测，使用方式和边界见下文；训练执行、专家管理、MCP/技能管理和安装包发布尚未接入。
- 本次验证的是本机 Windows 开发模式；其它平台和打包分发仍需单独验证。

## 算力连接

点击左侧栏“算力连接”，填写主机地址（支持 SSH config 别名、IPv4/IPv6）、端口、用户名，可选填远端工作目录和本机私钥文件路径。保存配置写入当前 Backend 工作区的 SQLite，旧版浏览器配置会作为初始草稿读取，成功保存后移除。首版管理一个当前计算目标。

“连接并检测”通过系统 OpenSSH 执行固定的 Python 3 探测脚本，返回远端系统、Python、目录可写性及 NVIDIA GPU UUID、型号、驱动和空闲/总显存。配置经参数数组和结构化输入传递，不拼接用户输入到远端 shell。GPU 探测失败与 SSH 访问失败分别显示；显存快照不构成资源预留。

连接沿用系统 SSH config、known_hosts、密钥代理与跳板配置。认证方式可选择“SSH 私钥 / 密钥代理”或“用户名和密码”。首次使用需先在终端以相同主机、端口和用户名连接，核对并信任主机指纹。加密私钥需先加载到 ssh-agent。密码登录通过临时、带随机凭据的本机回环 askpass 通道传递，密码不进入命令参数、环境变量、日志或数据库；连接结束或关闭弹窗后清空。密码模式只回答一次密码提示，不支持多步 MFA 或私钥口令；跳板机需已具备独立的密钥认证配置。远端要求 Linux 和 Python 3，GPU 信息需 NVIDIA 驱动及 nvidia-smi。可用 `TRAINERBUDDY_SSH_BIN` 指定 OpenSSH 可执行文件。

SSH 在连接成功后保留一条文件协议会话，目录、文件和经确认启用的发布宿主复用这次认证，不保留密码。界面分别显示硬件采集时间与最近联系时间；文件操作成功只更新联系时间。Backend 重启后必须重新登录，并在项目中重新启用上传服务；已安装的宿主文件可校验后复用。失败时保留同一配置的历史资源快照，更换目标后清除。关闭弹窗保留文件会话；“断开”、更换配置或退出桌面会关闭文件会话，均不向远端发送训练任务停止命令。发布宿主支持版本与摘要握手，训练任务提交和执行尚未接入。

API（使用现有 Backend 实例鉴权，响应为 `{success,data}`）：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/compute/target` | 读取配置、联系状态和带时间的快照 |
| PUT | `/api/v1/compute/target` | 保存 `{host,port,username,workdir,identity_file,auth_method}`，认证方式为 `key`（默认）或 `password` |
| POST | `/api/v1/compute/target/connect` | 保存同结构配置并检测，密码模式额外传递一次性的 `password`，最长 30 秒 |
| POST | `/api/v1/compute/target/disconnect` | 标记断开，保留历史快照 |
| GET | `/api/v1/compute/target/files?connection_id=…&path=…&cursor=…` | 分页列出当前连接的工作目录，path 为相对路径 |
| GET | `/api/v1/compute/target/file?connection_id=…&path=…` | 读取文件内容，返回 base64、大小和修改时间 |

同一时间只允许一个修改或连接操作，竞争请求返回 409，健康接口不等待 GPU 或 SSH 探测。连接失败作为目标状态返回，错误代码区分主机身份、认证、网络、Python 缺失和响应异常。

“算力连接 → 服务器文件”浏览连接时选择的目录；“项目工作台 → 文件 → 已发布版本”只浏览当前项目绑定下的最后成功发布版本。支持进入文件夹、返回上一级、路径导航、刷新、分页、UTF-8 文本只读预览、图片预览，以及已读取文件的下载。PDF 可读取后下载查看。文本预览上限 1 MiB，图片/PDF 预览上限 20 MiB；每页 500 项，每目录最多列 10000 项并明确提示截断。项目版本中的文件还可通过独立任务分块下载，不受预览大小限制。

访问范围固定为连接时配置的远端工作目录（留空则为用户主目录）。Python 文件协议使用规范化路径和 Linux 目录句柄逐级打开，拒绝 `..`、绝对路径、工作目录外的符号链接、FIFO 等特殊文件；不会跟随越界链接读取内容或元数据。文件请求必须携带本次 `connection_id`，切换目标或重连后旧请求返回 409，避免串用文件缓存。连接断开、超时或协议异常后清理会话，普通文件权限/不存在错误保留连接。

```powershell
node backend/scripts/toolchain.mjs build --examples --bins
node backend/scripts/test-compute.mjs
```

接口测试使用隔离数据库和 SSH 子进程 fixture，覆盖参数/输入边界、资源快照、错误分类、失败后快照保留、重复操作拒绝、健康检查和重启恢复。真实 SSH/GPU、跳板机与平台兼容性需使用实际目标另行验收。

密码认证失败会区分：本机 askpass 未交付密码、密码已交付但被服务器拒绝、服务器未提供密码认证。本机网络策略拒绝连接与已认证后的远端探测失败也有独立错误。诊断只保留错误代码，不存储原始 SSH 调试输出或密码。

`node backend/scripts/test-compute-real-ssh.mjs` 使用系统 OpenSSH 和回环 SSH 服务（Python Paramiko）验证真实密码认证、错误密码拒绝及探测数据传输。测试使用独立 known_hosts，不修改用户主机信任文件；Windows 客户端使用与应用相同的隐藏进程方式。该测试不访问用户配置的服务器，也不使用真实密码；GPU 与用户服务器策略仍需另行验收。

`python backend/scripts/test-remote-files.py` 在 Linux 上验证实际文件协议的分页、UTF-8、符号链接边界、权限和大小限制。`node frontend/desktop/scripts/verify-remote-files.mjs` 对启用本机 9223 调试端口的桌面应用验证目录切换、预览、下载链接、错误提示、断开重连和窄窗口；它使用隔离的界面响应，不读取真实服务器文件。

## 本地项目发布到 GPU 服务器

实现范围对应根目录实施方案 P0–P3：本地 Git 版本发布、远端版本浏览和文件下载。数据集/模型资产管理、训练执行、日志自动回收留待 P4。

1. 先通过“算力连接”登录 Linux x86_64 服务器，选择可写工作目录。
2. 打开“项目工作台 → 文件”，填写本地 Git 根目录和远端相对子目录，保存项目绑定。修改已有项目目录前须先结束该项目正在运行的 Agent。
3. 提交需要发布的本地修改，点击“检查本地版本”，检查 commit、文件清单和归档摘要。应用不会自动创建 Git 提交。
4. 点击“启用上传服务”，检查弹窗中的远端路径、二进制大小与摘要，再确认安装。宿主位于工作目录的 `.trainerbuddy/hosts/<sha256>/trainerbuddy-host`，无需 sudo。
5. 点击“发布代码”。只有远端验证归档和解包清单并返回发布凭据后，界面才显示完成。
6. 切换“已发布版本”读取文件，点击行内下载按钮创建传输任务。完成后任务显示本地文件路径，可复制。

每个项目在 `<workdir>/<remote_subdir>/.trainerbuddy/projects/<project_id>/releases/<snapshot_id>/repo` 获得独立版本目录，旧版本保留。连接、浏览和编辑本地文件均不会自动推送。更换服务器会阻止使用旧绑定；恢复任务必须匹配原目标和绑定 revision。断线后先重新登录、启用上传服务，再点击原任务的“恢复”。

源代码归档最多 256 MiB、单文件最多 32 MiB、最多 20000 项；拒绝凭据、Git LFS 指针、子模块及链接。数据集和权重应留在服务器独立目录，不随代码归档传输。下载写入 Backend 数据目录的 `results/<project_id>/<transfer_id>/`，经完整 SHA-256 校验后将临时文件原子改名；不会覆盖本地源码。

开发环境先生成 Linux 宿主包（构建产物已忽略）：

```powershell
node backend/scripts/build-host.mjs --setup
node backend/scripts/toolchain.mjs build --examples --bins
node backend/scripts/toolchain.mjs build --manifest-path host/Cargo.toml
node backend/scripts/test-project-sync.mjs
node frontend/desktop/scripts/verify-project-publish.mjs
```

新增 API（均有 `/api/v1` 前缀，沿用 Backend 鉴权）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / PUT | `/projects/{id}/compute-binding` | 项目绑定，写入携带 `expected_revision` |
| POST | `/projects/{id}/snapshot-preview`、`/snapshots` | 检查或保存快照，后者路径同属该项目 |
| POST | `/projects/{id}/publish` | 以 `request_id` 和预览的 `commit` 创建幂等发布任务 |
| GET | `/projects/{id}/transfers`、`/transfers/{transfer_id}` | 查询持久任务状态 |
| POST | `/transfers/{id}/resume`、`/cancel` | 恢复或取消原任务 |
| GET | `/projects/{id}/remote-files`、`/remote-file` | 读取最后发布版本，携带 `connection_id` 和相对 `path` |
| POST | `/projects/{id}/remote-download` | 以 `request_id` 和相对 `path` 创建分块下载 |
| GET / POST | `/compute/target/host`、`/compute/target/host/install` | 查看安装计划/握手状态，或确认安装；安装携带 `connection_id` |

传输进度每 2 秒查询数据库中的权威状态。schema v2 升级旧库前自动生成 `metadata.pre-sync-v1.sqlite` 备份。开发者可通过 `TRAINERBUDDY_HOST_PACKAGE_DIR` 指向包含 `manifest.json` 和 Linux 二进制的目录。

Linux 实测命令：`node backend/scripts/test-host-linux.mjs --runtime`。此开发脚本使用本机 `docker-desktop` WSL 的 `/mnt/host/<盘符>` 挂载，下载并校验仅供测试的 Python；产品仍复用服务器已有的 Python 3。验证记录和适用范围见 [验收记录](../reports/desktop/project-sync-implementation.md)。
