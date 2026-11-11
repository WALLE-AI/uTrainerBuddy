---
name: buddy-results
description: Interpret baseline and candidate results using verified evidence.
---

Read buddy-run-evidence first. Confirm each run's configuration, final metric, metric direction, evaluation split and relevant trajectory. Compare only compatible evaluation protocols and distinguish execution success from scientific improvement. Small gains may require repeated seeds. Validation selects variants; do not repeatedly optimize against a held-out test set.

Use run_compare with baseline_run_id and candidate_run_id before a numeric comparison. It reads actual evidence and checks the fixed evaluation protocol; comparable=false is a refusal to rank, not a zero score. Cite both Run IDs, commits, measured values and delta. A matching protocol is a declaration and hash-bound metric receipt, not independent proof that the program evaluated the correct data. Treat a single-seed improvement as preliminary; no automatic promotion or approval is provided. Legacy runs without evaluation specs cannot participate.

Give the outcome and limitations, then choose repair, refill, promote or stop with a concrete reason. A completed experiment is frozen as evidence; build on it through child experiments. Propose the next run within user constraints; automatic submission is unavailable. Save durable findings via buddy-reports and reference Run IDs and commits. Do not invent data to fill a table or chart.
