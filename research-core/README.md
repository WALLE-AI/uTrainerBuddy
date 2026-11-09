# OpenResearch research core

This directory owns the reproducible dependency and integration boundary for the research kernel. See the root `基于OpenResearch的智能体模型研发实施方案.md` for architecture and acceptance gates.

`upstream.lock.json` pins the exact upstream commit and `git archive` checksum. Production preparation uses an existing local Git object cache when available, or fetches the exact commit from the declared repository. It never copies the mutable reference working tree. Extracted sources, toolchains and compiler caches live under `.tools/research-core/`; distributable files live under `research-core/dist/`.

```powershell
node research-core/scripts/build-dashboard.mjs
node research-core/scripts/build.mjs --setup
node research-core/scripts/build-windows-gateway.mjs
node research-core/scripts/test-windows.mjs
node research-core/scripts/test-linux.mjs
node frontend/desktop/scripts/verify-research-window.mjs
```

The initial build host is Windows x64 and the execution target is Linux x64 musl. Zig and cargo-zigbuild are installed within the workspace. Upstream Cargo.lock is preserved and builds use `--locked`. The Linux CLI embeds the matching orx-host; the build preserves upstream's MIT license and writes SHA-256 manifests.

The service now embeds the matching native dashboard, including in development builds (`rust-embed/debug-embed`). Build the dashboard before either core binary. Its inventory and hashes are recorded in `dashboard.manifest.json`, copied into each package, and bound by the package manifest. Core builds verify these assets and never replace them with an API placeholder. For an already-built, verified local dashboard, `node research-core/scripts/dashboard.mjs --record` upgrades the inventory without downloading dependencies; this is not a substitute for building changed UI sources.

The desktop gateway verifies the package and the live HTML/entrypoint assets before opening a research window. The Windows service test runs a copied binary from an isolated directory, checks identity/Engine and every served asset. These checks do not replace desktop rendering, SSH workspace, Agent or real GPU acceptance. Keep internal `orx` commands, `ORX_` variables and frozen host contracts intact.

Development artifacts must not be presented as an official OpenResearch release. Source modifications belong in reviewed, versioned patches together with updated build identity and contract tests.

The Electron harness bundles the actual gateway, uses fresh test directories and hidden windows, and checks rendering, renderer isolation, concurrent opens and same-instance reopening. With `--main-app`, it loads the built production main/preload/renderer and backend, clicks the research sidebar, and checks same-instance reopening and denial of IPC from another window. Build the desktop app first. It does not test GPU training.

Versioned `patches/*.json` contain exact replacements against the pinned upstream archive. Preparation applies them only to unmodified or already-patched files; verification checks all 881 original paths against the declared result. Both package manifests record `patches_sha256`. Current patches consistently honor `ORX_SSH_CONFIG` in the dashboard and SSH transport, and allow copying native configuration files when Windows cannot hard-link across volumes. User configuration sources are not overwritten.

```powershell
node frontend/desktop/scripts/verify-research-window.mjs --main-app
node research-core/scripts/setup-linux-runtime.mjs
node research-core/scripts/test-ssh-workspace.mjs
# Optional: uses the installed native Codex and existing login/model service.
node research-core/scripts/test-ssh-workspace.mjs --agent
```

The SSH test uses actual Windows OpenSSH against a disposable non-root SSH account in a private WSL mount namespace. It pre-provisions the verified Linux core, submits a real Git/Local Run, disconnects and reattaches to the same workspace instance, checks logs and rejects a wrong key. Only test-owned processes and directories are cleaned up; failed artifacts are retained. This verifies a remote workspace, not remote installation or user GPU training. The optional Agent test requests exactly one deterministic SSH Run from a native chat/worktree and requires a report with the real Run ID and metric. Model calls may incur charges; failures are not counted as acceptance. See the root `研发迭代计划方案.md` and `reports/desktop/openresearch-core-implementation.md` for results and remaining gates.

For native Windows Agent acceptance, pass `--codex-binary <absolute-codex.exe-path>` to select the CLI and run a model-free sandbox read probe before submitting the prompt. The probe uses `:workspace` with managed requirements included. An absent setup marker or a full volume for the native home, user profile or temporary directory stops the probe before launching Codex. Initial provisioning must be performed explicitly; an existing marker does not guarantee that Codex will not refresh its state. This setup is separate from the user's existing Codex home. See [official Windows sandbox documentation](https://developers.openai.com/codex/windows).

`--agent-home <prepared-home>` optionally reuses a previously initialized **test** native home under `.tools/research-core/tests/`. A temporary junction connects the new test core to that home; cleanup removes the junction and preserves the prepared home. It does not copy sandbox secrets or setup markers between homes. Each acceptance still creates a fresh project and chat. The default remains a fresh native home. Successful Agent tests independently read Engine logs and write a compact report to `.tools/research-core/acceptance/agent-<run-id>.json` before removing temporary workspace data. Reports contain IDs, version identity and assertions, not login credentials or transcripts.

The probe resolves junctions before passing the native home to Codex, matching `native_store::prepare_codex` in the production core. Provisioning through an alias while the harness launches through its real path is not an equivalent preflight. Pin `--codex-binary` when multiple CLI versions are installed; a successful probe is not a replacement for the actual Agent acceptance.

The Linux test also kills only its copied server after matching the runtime descriptor and `/proc/<pid>/exe`, reconnects to a new instance, and requires the original Run to finish with one launch marker and no duplicate Run. Separate real runs verify cancellation and nonzero exit code 7 with retained logs. These fault tests cover the Linux Local adapter; they do not prove GPU recovery or every SSH failure mode.

The optional fourth positional argument to verify-codex-sandbox.mjs is a repeat count (1?3). Each successful read must leave the setup marker timestamp unchanged; a change is reported as unverified reuse, not proof of a download or cancelled setup. Assertions retain their original diagnostic. A full C: user-profile volume blocks Windows helpers even if the project is on F:.
