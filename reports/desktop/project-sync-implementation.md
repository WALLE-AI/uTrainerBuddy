# 项目与 GPU 服务器协同：实施验收记录

日期：2026-11-07  
范围：根目录《本地项目与 GPU 服务器协同实施方案》的 P0–P3。

## 已交付

- 正式 Project、持久 ComputeTarget、项目 Binding 与 revision；旧库 v1 → v2 备份迁移，多目录冲突保留待修复状态。
- 硬件快照采集时间独立于 SSH 联系时间；更换服务器、重连和切换项目隔离请求与缓存。
- 干净 Git HEAD 的固定归档、SHA-256 和清单预览；保留提交字节、中文文件名、换行及执行位。拒绝凭据、链接、子模块、LFS 指针和超限代码归档。
- 独立 Rust `trainerbuddy-host`，Linux x86_64 静态包和摘要清单；明确确认后安装至用户受管目录，校验权限、摘要及握手。
- 256 KiB 分块上传、偏移查证、重复块校验、完整摘要验证、原子发布及可查证发布凭据。版本目录相互独立，旧版本不被后续发布覆盖。
- SQLite 持久传输任务、幂等请求、断线与 Backend 重启后的手动恢复、取消；只有确认发布成功才更新项目最后版本。
- 项目内的已发布版本浏览与独立文件下载；下载在 Backend 流式写入临时文件、完整校验后改名，避免整份文件进入 Renderer。
- 中英文界面：保存绑定、检查版本、安装确认、发布阶段、进度、取消、恢复、下载路径。

主要实现：`backend/src/project_sync.rs`、`backend/host/`、`backend/src/host_bridge.py`、`backend/src/store.rs`、`backend/src/compute.rs`、`frontend/desktop/src/renderer/components/compute/ProjectPublish.tsx`、`RemoteFiles.tsx` 和 `components/layout/ProjectFiles.tsx`。

## 已执行验证

| 验证 | 结果与覆盖范围 |
| --- | --- |
| Backend 单元/接口测试 | 8 通过；含升级备份、冲突项目根、项目文件边界、SSH 状态持久化 |
| Windows Rust Host 测试 | 3 通过；版本发布与重复请求、分块恢复与损坏恢复、危险归档与清单不一致 |
| Linux Rust Host 测试 | 4 通过；在 WSL Linux 实际文件系统执行，额外覆盖受管写入拒绝符号链接及硬链接 |
| Linux 原始文件协议 | 通过；实际 Python 协议的分页、UTF-8、权限拒绝、链接边界、二进制/特殊文件及读取限额；使用非 root 用户 |
| Linux 宿主引导链路 | 通过；实际 Python bootstrap 上传并校验 ELF、使用只读可执行文件描述符启动 Rust Host、握手摘要、真实发布、读回及缓存重启 |
| 项目同步集成 | 通过；临时 Git 项目与实际 Windows Rust Host，A/B 独立版本、脏目录阻止发布、中文路径与 CRLF、绑定 revision、幂等冲突、分块响应丢失、Backend 重启后恢复原任务、1.5 MB 文件下载摘要、取消响应与切回服务器恢复稳定 ID |
| 现有 compute / protocol 回归 | 通过；认证、会话复用、错误分类、资源快照、健康检查；聊天协议映射、许可/拒绝、取消与崩溃恢复 |
| 系统 OpenSSH 实测 | 通过；Windows 系统 OpenSSH → 本机 Paramiko SSH 服务，密码认证、单次认证复用目录和文件读取、错误密码拒绝、旧 session 拒绝 |
| 项目发布 UI | 通过；保存绑定、脏目录禁用、快照预览、安装路径确认、发布阶段与凭据、服务器切换后禁用 |
| 远端文件 UI 回归 | 通过；目录导航、分页、中文预览、下载链接、超限提示、断开重连、窄窗口 |
| 静态检查与构建 | Backend 与 Host clippy 无警告；前端 TypeScript 与 Vite 构建通过；Rust 格式与 git diff 空白检查通过 |

测试仅使用隔离数据库、临时项目和测试凭据，没有读取用户 SSH 密码或向用户 GPU 服务器发布当前仓库。系统 OpenSSH 测试、Windows 集成和 Linux 文件系统测试分别验证各层，不能等同于已经完成用户 GPU 服务器上的端到端发布验收。

## 本次解决的实际兼容问题

- Windows 下 Git 归档继承 Backend 私有 stdin 导致等待：归档进程改用空 stdin。
- Git `archive` 自带 PAX global header：正确识别并跳过元数据头，继续逐条校验真正的文件。
- Linux 安装后以可写文件描述符执行引起 `ETXTBSY`：关闭写描述符，重新以只读描述符启动已校验的同一 inode。
- 安装和写入以目录描述符锚定受管根，阻止链接替换和多硬链接文件被意外修改。
- 发布凭据与任务完成同事务落库；取消标志不会被进度更新覆盖。下载摘要失败会清空损坏临时文件供恢复。

## 使用与限制

入口：**算力连接登录 → 项目工作台 → 文件 → 保存项目绑定 → 检查本地版本 → 启用上传服务 → 发布代码 → 已发布版本**。本地修改需要先自行提交。应用重启后需重新 SSH 登录并启用上传服务，可复用远端已校验的宿主。

当前宿主支持 Linux x86_64，远端需 Python 3、目录写权限及执行权限。源归档最多 256 MiB、单源文件 32 MiB、20000 条目；大型数据/模型不应放入代码快照。文件下载按块进行，当前入口仅覆盖项目最后发布版本内的文件，不是任意外部资产下载。

传输状态由前端每 2 秒查询，尚无传输 WebSocket 事件。训练执行、AssetRef、独立资产上传、日志/报告自动回收和远程工作区仍属 P4/P5。真实 GPU 服务器发布、长时间传输、真实断网和磁盘满等场景尚需目标环境验收。

复现命令与用户步骤见 [Backend README](../../backend/README.md)。桌面开发服务已使用最新 Backend 重启，Renderer 地址为 `http://localhost:5174/`。
