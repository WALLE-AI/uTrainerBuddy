# OpenResearch research core

On a fresh Windows host, run `./research-core/scripts/setup-wsl.ps1` from an administrator PowerShell to install the WSL runtime without a default Linux distribution. It uses the official `wsl --install --no-distribution --web-download` command, keeps temporary downloads and logs under `.tools/tmp`, and never restarts Windows. Windows system components use their system installation locations. Inspect `.tools/tmp/wsl-install-result.json` and the adjacent stdout/stderr logs: pending Windows features or the Windows servicing reboot marker require a restart before Linux execution can be verified, even if installation returns zero and the feature already reports Enabled. Use `-InspectOnly` to refresh the recorded feature/reboot state without reinstalling; it requires an existing result file. This step does not create a test distribution or prepare its runtime; configure the isolated Alpine environment as described below. See [Microsoft's WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

This directory owns the reproducible dependency and integration boundary for the research kernel. See the root `基于OpenResearch的智能体模型研发实施方案.md` for architecture and acceptance gates.

Linux test setup and execution share `backend/scripts/wsl.mjs`. Prepare the dedicated **Alpine** WSL2 distribution, then select it in the same PowerShell session before running setup/test commands:

```powershell
node research-core/scripts/setup-test-distro.mjs
$env:TRAINERBUDDY_WSL_DISTRO = 'trainerbuddy-test'
node backend/scripts/setup-linux-python.mjs
node research-core/scripts/setup-linux-runtime.mjs
node research-core/scripts/test-linux.mjs
node research-core/scripts/test-ssh-workspace.mjs
```

The distro setup verifies the official Alpine 3.22.8 x64 rootfs SHA-256 and imports `trainerbuddy-test` into `.tools/wsl/trainerbuddy-test` on the project drive. It installs namespace tools, checks the project mount and reuses an existing distro only when its local receipt and internal fixture marker match. It never unregisters an existing distro. The fixture needs Alpine's `apk`, musl and BusyBox; selecting Ubuntu is not sufficient. Package dependencies use the configured Alpine repositories. With no override, `docker-desktop` and `/mnt/host/<drive>` remain the defaults. Other distributions default to `/mnt/<drive>`; set `TRAINERBUDDY_WSL_MOUNT_ROOT` if their Windows-drive mount root differs. Setup, preflight, fixture launch and key copies all use the selected distribution explicitly as root for private namespace/chroot setup. Actual experiments still use the fixture's unprivileged account. Regression command: `node --test backend/scripts/wsl.test.mjs research-core/scripts/ssh-preflight.test.mjs`.

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
node research-core/scripts/ssh-preflight.mjs
node research-core/scripts/test-ssh-workspace.mjs
# Optional: uses the installed native Codex and existing login/model service.
node research-core/scripts/test-ssh-workspace.mjs --agent --codex-binary <absolute-codex.exe-path> --agent-home <prepared-test-home>
```

The SSH test uses actual Windows OpenSSH against a disposable non-root SSH account in a private WSL mount namespace. It pre-provisions the verified Linux core, submits a real Git/Local Run, disconnects and reattaches to the same workspace instance, checks logs and rejects a wrong key. Only test-owned processes and directories are cleaned up; failed artifacts are retained. This verifies a remote workspace, not remote installation or user GPU training. The optional Agent test requests exactly one deterministic SSH Run from a native chat/worktree and requires a report with the real Run ID and metric. Model calls may incur charges; failures are not counted as acceptance. See the root `研发迭代计划方案.md` and `reports/desktop/openresearch-core-implementation.md` for results and remaining gates.

The SSH harness runs `ssh-preflight.mjs` before creating its test workspace. It aggregates missing core files and Windows commands, and checks the private Python/Git/Bash/SSH runtime through a bounded WSL command. The standalone preflight does not install software, create accounts, or invoke models. Success means prerequisites are available, not that package integrity, SSH or Agent acceptance passed. Run its regression checks with `node --test research-core/scripts/ssh-preflight.test.mjs`.

Before creating the workspace or starting either service, the SSH harness also runs `verifyResearchPackages`. Both packages must match the versioned upstream commit, source archive and current patches, declare the expected target and embedded UI, and contain the exact required files with matching sizes and SHA-256 hashes. The Linux package must enable the Run Engine and both Dashboard manifests must match. Agent evidence records the verified package manifests and binary hashes instead of attributing unchecked binaries to the current source. These are consistency checks, not publisher signature verification or real experiment acceptance. Regression command: `node --test research-core/scripts/verify-packages.test.mjs research-core/scripts/ssh-preflight.test.mjs`.

For native Windows Agent acceptance, pass `--codex-binary <absolute-codex.exe-path>` to select the CLI and run a model-free sandbox read probe before submitting the prompt. The probe uses `:workspace` with managed requirements included. An absent setup marker or a full volume for the native home, user profile or temporary directory stops the probe before launching Codex. Initial provisioning must be performed explicitly; an existing marker does not guarantee that Codex will not refresh its state. This setup is separate from the user's existing Codex home. See [official Windows sandbox documentation](https://developers.openai.com/codex/windows).

Agent acceptance requires both `--codex-binary <absolute-codex.exe-path>` and `--agent-home <prepared-home>`. Before starting SSH fixtures or creating a workspace, a read-only check verifies the binary and an existing sandbox setup marker in a **test** native home under `.tools/research-core/tests/`. Missing prerequisites stop the test; provisioning must happen explicitly. A marker alone does not establish sandbox stability: the existing shell probe still runs before model submission. A temporary junction connects the new test core to that home; cleanup removes the junction and preserves the prepared home. It does not copy sandbox secrets or setup markers between homes. Each acceptance still creates a fresh project and chat. Successful Agent tests independently read Engine logs and write a compact report to `.tools/research-core/acceptance/agent-<run-id>.json` before removing temporary workspace data. Reports contain IDs, version identity and assertions, not login credentials or transcripts. Run the prerequisite regression with `node --test research-core/scripts/agent-preflight.test.mjs`.

The probe resolves junctions before passing the native home to Codex, matching `native_store::prepare_codex` in the production core. Provisioning through an alias while the harness launches through its real path is not an equivalent preflight. Pin `--codex-binary` when multiple CLI versions are installed; a successful probe is not a replacement for the actual Agent acceptance.

The Linux test also kills only its copied server after matching the runtime descriptor and `/proc/<pid>/exe`, reconnects to a new instance, and requires the original Run to finish with one launch marker and no duplicate Run. Separate real runs verify cancellation and nonzero exit code 7 with retained logs. These fault tests cover the Linux Local adapter; they do not prove GPU recovery or every SSH failure mode.

The optional fourth positional argument to verify-codex-sandbox.mjs is a repeat count (1?3). Each successful read must leave the setup marker timestamp unchanged; a change is reported as unverified reuse, not proof of a download or cancelled setup. Assertions retain their original diagnostic. A full C: user-profile volume blocks Windows helpers even if the project is on F:.
