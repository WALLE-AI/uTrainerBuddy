# 桌面 UI 第一轮调整

以 `prototypes/trainer-buddy/agent.html` 为设计参照，在现有 React 页面和布局中逐步修改。

- 保留 `main.tsx`、路由、认证、现有会话状态、Agent 调用与项目数据链路。
- 首页加入四类研究起点，点击追加到现有草稿并聚焦输入框，不自动发送。
- 调整首页间距、输入框和左栏视觉；窄窗口起点卡片改为单列。
- 现有 `ProjectPanelHost` 增加上下文工作台标题、资产说明和收起按钮；Explorer 保持挂载。
- 修复原有 Electron 窗口控制被 HTTP 空实现截断的问题。

训练指标、任务状态与样本审核没有添加演示替代实现，后续沿真实对象和现有组件继续迭代。

验证：`bun run build` 通过。`scripts/verify-workspace.mjs` 在实际 Electron 窗口检查四类起点保留草稿、输入框聚焦、不自动请求和原生窗口 IPC，并保存桌面与窄窗口截图。项目工作台需绑定真实项目后进一步检查文件操作与预览。

启动：在 `frontend/desktop` 运行 `bun run electron:dev`。需要运行交互检查时添加 `-- --remote-debugging-port=9223`，再运行 `node scripts/verify-workspace.mjs`。

## 右侧工作台

按照原型的右侧栏结构增加“计划 / 运行 / 资产 / 记录”，支持固定观察会话、来源提示、页签键盘导航、展开/恢复宽度和收起；移动端使用同一工作台组件。固定状态限制在当前项目内，页签按观察会话记忆。文件树在切换页签、会话和收起时保持挂载。

计划读取后端最近一次 Agent 计划，运行页读取会话 runtime，记录页读取最近 30 条会话消息；可见时每 5 秒刷新。引用计划通过带目标会话 ID 的事件追加到当前草稿，不自动发送。训练任务、GPU 指标、检查点仍未接入，界面明确说明。

验证：`npm run build`；`node scripts/verify-workbench.mjs` 在独立 Electron 测试配置下检查计划进度、固定/跟随、引用目标、宽度切换、隐藏后的 inert、文件树生命周期、记录展开、失败重试、项目隔离、220px 宽度与移动端覆盖层。交互检查使用 `scripts/workbench-fixture.tsx` 注入的测试数据，不代表训练后端联调。

截图：`workbench-plan.png`、`workbench-narrow.png`，均为测试数据下的实际组件渲染。

## 后端连接

本仓库当前不包含可启动的会话后端。默认后端端口 13400 无服务，未配置后端时开发服务器的 `/api/conversations` 返回 404，因此窗口打开不代表真实会话可用。

会话读取失败时保留当前地址，显示“重试”和“返回首页”；仅后端明确返回会话不存在时跳回首页。产品界面直接使用正式首页和会话页，不提供离线演示入口或模拟任务状态。

## 算力连接入口

正式首页左栏在“专家”下方、“定时任务”上方放置“算力连接”。点击打开 SSH 配置面板，支持主机、端口、用户名与远端工作目录；配置只保存到当前设备，未接入 SSH 服务前始终显示“未连接”。

左上角品牌图标使用新设计的 U 形伙伴图标，资源为 `src/renderer/assets/utrainerbuddy-icon.svg`。

隔离验证启动命令（PowerShell）：

```powershell
$env:UBIDBUDDY_E2E_TEST='1'
$env:UBIDBUDDY_E2E_USER_DATA_DIR="$PWD/out/workbench-test-userdata"
npm run electron:dev -- --remote-debugging-port=9223
```
