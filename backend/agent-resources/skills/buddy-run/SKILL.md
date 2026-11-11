---
name: buddy-run
description: Prepare a committed local experiment for explicit user approval and asynchronous execution.
---

Read buddy-experiment-code and the current research plan. Local execution is supported; SSH training and automatic execution grants are not yet supported. Use an existing installed interpreter/environment and respect the project dependency tooling.

Read research_control_get before advancing a run. When paused, the backend rejects new execution approval and holds automatic result messages. Preparation, evidence reads, explicit conversation and cancellation remain available. Existing runs and already accepted analysis turns continue. Only the user resumes research from the workbench; do not bypass pause with shell or HTTP.

Call run_prepare with a stable request_id, experiment_id, plan_id, current plan_hash, explicit argv array and timeout_seconds (1–3600). The backend freezes a code snapshot and the plan. Preparation does not launch. Explain the command, target, timeout and run ID; ask the user to inspect and approve that concrete run in the existing workbench. Do not bypass approval using shell, SSH or HTTP.

Also supply evaluation: dataset, dataset_version, split, evaluator_sha256 (64 lowercase hex), metric, direction (maximize/minimize), seed (nonnegative integer). Use the actual fixed evaluator file hash and reproducible data version; do not invent a hash. Freeze the evaluator independently of model/training edits so candidates use the same protocol. If identity cannot be established, finish the research plan first and identify what is missing. Changing evaluation within one experiment is rejected; create a child for a new protocol and do not claim comparability with its parent.

The evaluator hash must match a file in the committed source snapshot; hash committed bytes rather than a checkout with different line endings. External evaluator dependencies are not covered by this first protocol. The backend verifies presence of the source file, not that the payload actually invokes it.

The payload receives TRAINERBUDDY_RUN_ID, TRAINERBUDDY_OUTPUT_DIR and TRAINERBUDDY_METRICS_FILE. Write JSON lines with schema_version=1, run_id, stage, metric, step, value; flush periodically and include final evaluation. Save checkpoints and reports under the output directory. Keep artifacts at its top level for the initial inventory API. Training code owns model saving; process success alone is not model delivery.

The payload also receives TRAINERBUDDY_EVALUATION_SPEC and TRAINERBUDDY_EVALUATION_HASH. After evaluating the specified protocol, include evaluation_hash in each matching evaluate metric. The backend requires a unique final (greatest step) record for the specified metric. Merely copying a hash cannot prove the scientific validity of evaluation; validate the actual evaluator and dataset in code review.

After approval the backend runs independently and delivers a result message. End the turn rather than keeping an agent polling. Use run_get/evidence for requested progress and run_cancel only for a run the user wants stopped or whose failure requires stopping. Missing contact never authorizes automatic relaunch. There is no implicit GPU or remote execution support in this version.
