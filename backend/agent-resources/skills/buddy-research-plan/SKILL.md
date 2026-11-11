---
name: buddy-research-plan
description: Turn a research request into an evidence-based project Markdown plan.
---

Inspect relevant code and existing research_document_list/read results first. Clarify only missing decisions that materially affect the plan; label assumptions. For deep research, consult buddy-literature and use available literature tools when the question requires external evidence.

Include: objective/question; verified sources and limits; candidate approaches; recommendation and rationale; baseline; a small round of comparable hypotheses; fixed evaluation metric, direction, data split and seeds; compute/environment constraints; budget and stopping conditions; required artifacts; unresolved decisions.

Save using research_document_write. For creation use a new request_id and null id/expected_hash; identical retries reuse the request_id. For edits use the current document id/hash and a new request_id. Resolve conflicts by re-reading; never overwrite external edits blindly. The returned file is authoritative. Link it in the response.

A plan is not a completed experiment or permission to start one. Never substitute shell/SSH training for unavailable run tools. No need to create a legacy research record as a second copy of the plan.
