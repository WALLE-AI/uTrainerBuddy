# OpenResearch 研究内核实施记录

日期：2026-11-08。依据：[新版实施方案](../../基于OpenResearch的智能体模型研发实施方案.md)。

## 进度

- M0 已通过：固定源码、构建入口、协议清单、Linux 真实启动及实验执行冒烟。
- M1 实施中：Windows/Linux 已嵌入完整原生 Dashboard；隔离 Electron 研究窗口渲染、重复打开与关闭重开接回通过。主应用侧栏 IPC、真实 SSH 工作区安装/接回仍待完整验收。
- M2 部分验证：真实 Git baseline、Local adapter、快照、wrapper 执行、断开后接回原 Run、日志回收已通过；真实 SSH 计算节点和完整桌面流程待验收。
- M3–M5 未完成：结果唤醒 Agent 的集成验收、预算扩展、模型训练观测和用户 GPU 实机闭环。

不能将上游源码已有某能力视为本产品已经集成验收，也不能将文档或轻量实验视为模型训练成功。

## 固定内核与构建

源：`https://github.com/alphaXiv/OpenResearch.git`，commit `52a3ca22971f4042da4c73f1f3fca8e04aca9089`，版本 `0.2.24`。

`research-core/upstream.lock.json` 固定 `git archive` 的 SHA-256 `1d9d6d9adce89330e31668f4f697de7c739e27de082ff2717e31c6efdee9894b`，大小 23009280 字节。881 个源码文件与原始归档逐一核对，不复制参考 clone 的可变工作树。缺少本地缓存时按固定远端与 commit 获取。

Linux core/host 和 Windows 原生 core 均已实际编译。保持上游 Cargo.lock 与 `--locked`，保留 MIT LICENSE。产物位于 `research-core/dist/`，工具及缓存位于 F 盘 `.tools/research-core/`，生产依赖入口不指向被忽略的 `opensource/`。

使用 Zig 0.14.1（官方 SHA 验证）和 cargo-zigbuild 0.20.1；首次发现 C 盘可用空间为零，已将 cargo-zigbuild/Zig 缓存显式改到 F 盘，没有删除用户文件。

```powershell
node research-core/scripts/build.mjs --setup
node research-core/scripts/build-windows-gateway.mjs
node research-core/scripts/build-dashboard.mjs
node research-core/scripts/setup-linux-runtime.mjs
node research-core/scripts/test-linux.mjs
```

`research-core/contracts/upstream-surfaces.json` 保存固定源码的 Dashboard 5、remote control 1、CLI discovery 2，以及原生 API/attachment 契约。新研究工作区显式设置 `ORX_RUN_ENGINE=1`。

## 实际 Linux 验证

在本机 docker-desktop WSL，以非 root 用户和独立临时数据目录执行真实 Linux ELF、Git、内核及 wrapper。Git/Bash 使用 APK 签名验证安装至 `/tmp/trainerbuddy-research-runtime/`，没有修改 Docker Desktop 的系统根目录。

验证结果：

1. `remote-host ensure/attach` 实际启动并连接常驻内核；token 经 stdin 传入。
2. 正确身份/协议和 API 鉴权通过，错误 token 被拒绝，新 Engine 实际启用。
3. 注册真实 Git 项目、建立 baseline，经内核 CLI 启动 Local 实验。
4. attachment 断开后接回同一 instance，仍只有原始 Run，没有重复启动。
5. Run 进入 `done`，读回真实日志的 `metric.accuracy=0.75`。该数值来自轻量测试程序，不是真实模型测量。
6. 测试按实例和活动预览停止自己的服务并等待退出，再清理临时数据。

测试不访问用户项目、SSH 密码或模型服务凭据。Python/Node 脚本语法检查、前端 TypeScript 检查和 `git diff --check` 已通过。

## 桌面接入与剩余工作

研究入口使用独立 Electron 窗口展示固定版本原生 Dashboard；旧主界面、历史聊天及 metadata.sqlite 隔离保留，不把旧传输记录伪装为训练记录。

启动校验二进制大小与 SHA-256，发现使用随机 nonce/HMAC 验证服务；IPC 限主窗口主 frame，新窗口禁用 Node/preload，检查本地服务 origin。内核负责远程 attachment、研究状态与空闲退出，关闭展示窗口不自动取消任务。

固定 pnpm 12 使用原生二进制，构建脚本已兼容。首次界面安装因镜像元数据缺失被 minimumReleaseAge 策略拒绝，现改用 npm 官方源，保留原锁、完整性与策略检查，没有降低安全策略。网络下载曾出现 TLS 中断，构建仍在恢复。

上述下载阻塞为早期记录；2026-11-08 后续已确认原生 Dashboard 构建产物存在，并完成下述集成验证。

仍需完成：主应用入口完整验收、SSH 工作区安装/接回、原生 Agent 与结果唤醒、预算、真实训练及 GPU 指标。只有逐项取得实际证据后才更新为完成。

## 研发迭代 I1：原生 Dashboard 与本机窗口验收

执行计划：根目录 `研发迭代计划方案.md`。本轮不将 M1 整体标记完成。

发现并修复了两个实际交付缺口：Linux 构建会将已经生成的 UI 首页覆盖为占位页；开发模式的 rust-embed 默认从源码目录读取资源，二进制及一份 UI 清单的存在不能证明可交付 Dashboard。

现在先构建 Dashboard，生成全部资源的大小/SHA-256 清单，再编译 Windows/Linux core；显式开启 `rust-embed/debug-embed`，保留上游源码与锁文件，不修改冻结运行协议。清单复制到分发目录并纳入包摘要。网关只读取包内清单，校验实际服务首页和 JS/CSS 入口，拒绝占位页或不匹配页面。Inlang 生成元数据/cache 单独识别，固定归档的 881 个源码文件仍逐一校验。

| 命令/验证 | 本轮结果 |
| --- | --- |
| `node research-core/scripts/dashboard.mjs --record` | 对现有已构建 Dashboard 补齐全量资源清单，随后校验通过；不是重新执行依赖下载 |
| `node research-core/scripts/build-windows-gateway.mjs` | 通过，开发二进制内嵌原生 UI |
| `node research-core/scripts/build.mjs` | 通过；交叉链接器有命令回显警告，无构建失败 |
| `node research-core/scripts/test-windows.mjs` | 通过：隔离目录复制二进制，HMAC 身份、Engine、380 个资源及根页面摘要、同一 instance |
| `node research-core/scripts/test-linux.mjs` | 通过：380 个资源、真实 Git baseline、Local Engine/wrapper、detach/reattach、唯一 Run 和真实日志 |
| `node frontend/desktop/scripts/verify-research-window.mjs` | 通过：实际生产网关、并发只开一个窗口、真实 DOM 渲染、无 Node/preload bridge、关闭重开同一服务 |
| 前端 `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 修改的 Node 脚本语法及 `git diff --check` | 通过 |

Electron 测试使用全新数据目录和隐藏窗口，不访问原有工作区或发送 Agent 请求。早期截图步骤受隐藏窗口影响超时，已移除截图并关闭测试窗口后台节流；通过结果来自 DOM 与实际服务身份断言，不包含截图验收。测试退出清理自己的服务，未停止用户已有服务。

本轮覆盖本机服务与独立研究窗口，不覆盖主应用侧栏完整调用链、真实 SSH 工作区、用户 GPU 或论文复现指标；Linux 测试中的 accuracy=0.75 仍为测试程序输出。

## 后续执行：主应用入口、真实 SSH 与原生 Agent

日期：2026-11-08。以下结果补充并更新上文剩余项，未将 I1/I2 整体标记完成。

| 验证 | 实际结果 |
| --- | --- |
| 桌面 `electron-vite build` | 通过，真实主应用构建 |
| `node frontend/desktop/scripts/verify-research-window.mjs --main-app` | 通过：真实侧栏点击经生产 preload/IPC 打开研究窗口；重复打开保持一个窗口；关闭后接回同一服务；其他窗口调用被拒绝 |
| `node research-core/scripts/test-ssh-workspace.mjs` | 通过：实际 Windows OpenSSH 认证、远程工作区代理与身份/协议、真实 Git/Local Run、detach/reattach、唯一 Run 与日志、错误密钥拒绝 |
| Windows/Linux core 构建与 `test-windows.mjs` / `test-linux.mjs` | 三个受控补丁下构建通过；各 380 个资源及 Linux 原生实验回归通过 |
| `node research-core/scripts/test-ssh-workspace.mjs --agent` | SSH 部分通过；原生 Codex 会话创建并收到模型回复，但工具执行被 Windows 沙箱辅助程序启动失败阻塞，未完成 Agent Run 验收 |
| Python AST、补丁 JSON、修改的 Node 入口语法、`git diff --check` | 通过 |

新增 SSH fixture 在私有 WSL mount namespace/chroot 中运行 SSH，使用临时非 root 用户、临时密钥及预置的固定版本 Linux 内核。真实实验在远端使用 Local adapter，证明工作区接回及进程执行，不等于 Windows Agent 的 SSH adapter 验收。目录复制排除设备文件和运行目录；退出仅停止测试 namespace 的服务和进程。失败诊断保留在独立测试目录，未停止用户已有 OpenResearch 服务。

集成发现并修复：`0001-consistent-ssh-config.json` 使 Dashboard 识别 `ORX_SSH_CONFIG`；`0002-workspace-ssh-config.json` 使 Windows SSH 探测及隧道采用同一配置；`0003-windows-cross-volume-native-files.json` 处理原生配置从 C 盘到 F 盘无法硬链接的兼容问题。补丁基于固定 commit 的归档精确匹配，拒绝覆盖未知源码修改，校验全部 881 个源码文件，包清单记录 `patches_sha256`。

原生 Agent 验收是显式 `--agent` 模式，使用现有 Codex 登录和模型服务，限定测试仓库、测试 SSH 主机和一次确定性实验；测试超时中断会话，不自动批准权限请求。跨盘修复后会话已能初始化，最新原生日志显示 shell 工具失败：`orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223`。这是 Windows 沙箱启动环境阻塞，不能记作 SSH Run 成功，也没有通过关闭沙箱规避。最新失败材料目录：`.tools/research-core/tests/ssh-workspace-kgqerT`；其中可能包含原生会话配置/记录，仅供本机诊断，不应打包发布。

剩余门槛：原生 Codex Windows 沙箱恢复后重跑一次 Agent 提交/结果分析；远端未安装内核时的安装与升级；I2 后端重启/取消；I3 outbox 第二轮与服务端预算；论文/仓库复现以及用户 GPU 真正训练。测试指标仅为脚本输出，不是模型训练结果。

## I2：解除沙箱阻塞并验证真实 Agent 实验（2026-11-08）

上述 Windows 1223 问题已在隔离测试环境解除。原生日志明确记录 `sandbox setup marker missing or incompatible`：研究内核隔离了原生数据目录，该目录需要自己的正常沙箱初始化。使用已安装 `codex-cli 0.166.0` 的原生管理员设置流程后，无模型调用的 `codex sandbox -P :workspace --include-managed-config` shell 读文件预检通过。未切换到 full access/unelevated，未复制用户的 sandbox secrets/setup marker。初始化机制参考 [OpenAI 官方 Windows sandbox 文档](https://developers.openai.com/codex/windows)。

新增 `verify-codex-sandbox.mjs` 只允许已存在、真实路径位于研究测试目录内的 native home 与工作目录。`test-ssh-workspace.mjs --agent --codex-binary <绝对路径> --agent-home <已初始化测试目录>` 可以在新项目和新会话中复用测试 native home，退出时移除临时 junction，保留初始化目录。未指定 `--agent-home` 时仍使用全新目录；首次初始化可能需要原生系统授权。

原生 Agent 验收已通过：真实 Windows SSH 连接隔离 Linux 工作区；Agent 创建独立 worktree，提交恰好一个 SSH Run，Run 达到 `done`，Agent 回答包含该 Run 的真实 ID 和 `metric.fixture=1`。这是实际模型调用及实际 Run Engine 执行；测试脚本输出的指标不代表模型质量。脚本另增加独立 `orx logs <runId>` 断言与 `.tools/research-core/acceptance/agent-<runId>.json` 持久化证据，避免临时目录清理后只剩终端 PASS。

`node research-core/scripts/test-linux.mjs` 扩展验收已通过：

1. 原有 380 个 UI 资源、认证、真实 Git baseline/Local Run、detach/reattach 回归通过。
2. 创建 20 秒实验，确认 running 后核对实例/端口与 `/proc/<pid>/exe` 指向本次复制的二进制，再 SIGKILL 测试服务。重新 ensure 得到新 instance；原 Run 完成，日志中启动标记恰好一次，数据库没有多出重复 Run。
3. 创建长实验，执行原生 `exp cancel`，最终状态为 `cancelled`，未出现成功指标。
4. 创建退出码 7 的实验，最终状态 `failed`，API 保留 `exitCode=7`，日志仍可读取。

初次恢复测试因错误地在 Windows 风格的数据目录中查找 Unix 描述文件而失败；已修正为 Unix 的 `/tmp/orx-<uid>` 位置，同时保留实例、端口、二进制路径三项核对。测试未停止任何用户服务。Node/Python 语法与差异空白检查通过。

边界：本轮是单 Agent 小实验闭环以及 Linux Local adapter 的服务故障验收；不是全部 SSH/GPU 故障组合，也未证明重复通知去重、预算或自主第二轮。I2 的这两项基础门槛完成，下一主任务为 I3；I1 自动安装/升级与 I2 SSH 计算侧故障注入仍保留待办。

稳定性复测：0.166 的首次原生实验成功后，为新增独立日志断言及持久化证据进行的第二次运行未通过。无模型预检通过，但 Agent 工具执行时原生日志再次出现 `sandbox users missing or incompatible with marker version`，随后模型请求在沙箱外读取项目指令；测试没有批准该请求，主动中断并保留 `.tools/research-core/tests/ssh-workspace-KDU4yd`。本机存在 0.166/0.167 多个 Codex 安装，版本冲突目前是待验证假设；不能把第一次 PASS 描述为长期稳定。后续使用本机已有 0.167、相同沙箱与审批设置继续验证。

进一步源码核对发现预检路径不一致：内核 `native_store::prepare_codex` 返回规范化真实路径，而预检最初把临时 junction 路径直接作为 native home。已修正预检为 `realpath(nativeHome)` 与 `realpath(cwd)`，保持测试预检与生产 Harness 使用同一个物理目录。该差异是确定的代码问题；它与多版本沙箱错误的因果关系仍需复测，不能仅凭版本共存推断根因。

最后一次 0.167 运行在 240 秒等待预算内未完成 Agent 验收，测试已中断并清理其服务，诊断目录为 `.tools/research-core/tests/ssh-workspace-wVeChy`。该进程启动早于预检真实路径修正，不能作为修正后的验证结果。当前结论是“一次原生实验成功、Linux 恢复验收通过、Windows 重复运行稳定性未通过”；不是 I2 整体完成。新增独立日志断言/持久化报告仍待完整成功运行证明，当前没有新的成功证据 JSON。

重复沙箱提示的已知因素：测试最初每次创建全新的 native home；复用后预检 junction 路径与生产 canonical 路径不一致。日志中的 helper copy 也可能只是校验并复用本机二进制，不能等同于每次联网下载。已暂停重复初始化与模型调用，后续优先验证固定测试 home 的路径及运行状态，不通过关闭沙箱或自动批准外部执行请求获取 PASS。
