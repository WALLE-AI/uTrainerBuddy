use crate::{research, store::Store};
use anyhow::{anyhow, bail, Result};
use axum::http::Method;
use serde_json::{json, Value};
use std::collections::HashMap;


pub fn definitions() -> Value {
    let mut fields = json!({"title":{"type":"string","minLength":1,"maxLength":200},"objective":{"type":"string","minLength":1,"maxLength":16000},"evaluation":{"type":"string","maxLength":16000},"constraints":{"type":"string","maxLength":16000},"plan":{"type":"array","minItems":1,"maxItems":30,"items":{"type":"string","minLength":1,"maxLength":2000}}});
    let mut create = fields.clone();
    create["request_id"] = json!({"type":"string","minLength":1,"maxLength":128});
    fields["research_id"] = json!({"type":"string"});
    fields["expected_revision"] = json!({"type":"integer","minimum":1});
    let spec = |name: &str, description: &str, properties: Value, required: Value| json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    let mut tools = json!([
        spec("research_list","Read this conversation's research goals and plans before creating or editing.",json!({}),json!([])),
        spec("research_get","Read one research goal and plan in this conversation.",json!({"research_id":{"type":"string"}}),json!(["research_id"])),
        spec("research_create","Persist a research goal and ordered plan. This does not execute experiments. Reuse request_id for identical retries.",create,json!(["request_id","title","objective","evaluation","constraints","plan"])),
        spec("research_update","Update a goal and plan using the last observed revision; preserve user changes. This does not execute experiments.",fields,json!(["research_id","expected_revision","title","objective","evaluation","constraints","plan"]))
    ]);
    tools.as_array_mut().unwrap().extend([
        spec("research_control_get","Read whether this conversation's research progression is paused. Pause blocks new training starts and automatic result delivery; it does not cancel existing runs. Only the user can resume in the workbench.",json!({}),json!([])),
        spec("experiment_create","Create an isolated Git worktree for a baseline or hypothesis; does not run or commit user edits. Read buddy-experiment-code first. Edit and commit in the returned worktree.",json!({"request_id":{"type":"string"},"title":{"type":"string"},"parent_id":{"type":["string","null"]}}),json!(["request_id","title","parent_id"])),
        spec("experiment_list","List this conversation's persisted experiments.",json!({}),json!([])),
        spec("run_prepare","Freeze the committed experiment code, current plan and execution command for user review. Does not authorize or launch. Read buddy-run first. User approves the concrete run in the workbench.",json!({"request_id":{"type":"string"},"experiment_id":{"type":"string"},"plan_id":{"type":"string"},"plan_hash":{"type":"string"},"argv":{"type":"array","items":{"type":"string"}},"timeout_seconds":{"type":"integer","minimum":1,"maximum":3600},"evaluation":{"type":"object","properties":{"dataset":{"type":"string"},"dataset_version":{"type":"string"},"split":{"type":"string"},"evaluator_sha256":{"type":"string"},"metric":{"type":"string"},"direction":{"type":"string","enum":["maximize","minimize"]},"seed":{"type":"integer","minimum":0}},"required":["dataset","dataset_version","split","evaluator_sha256","metric","direction","seed"],"additionalProperties":false}}),json!(["request_id","experiment_id","plan_id","plan_hash","argv","timeout_seconds","evaluation"])),
        spec("run_compare","Compare two successful runs using matching fixed evaluation protocols and actual final metrics. Returns not comparable with a reason when evidence is incompatible. No automatic promotion.",json!({"baseline_run_id":{"type":"string"},"candidate_run_id":{"type":"string"}}),json!(["baseline_run_id","candidate_run_id"])),
        spec("run_list","List prepared and executed runs in this conversation.",json!({}),json!([])),
        spec("run_get","Read a run and its actual lifecycle state.",json!({"run_id":{"type":"string"}}),json!(["run_id"])),
        spec("run_evidence","Read real logs, metrics and artifact inventory. Read buddy-run-evidence first. Missing metrics are not zero.",json!({"run_id":{"type":"string"},"offset":{"type":"integer","minimum":0}}),json!(["run_id","offset"])),
        spec("run_cancel","Request cancellation of a run. Only an execution receipt proves it stopped.",json!({"run_id":{"type":"string"}}),json!(["run_id"])),
        spec("research_skill_list","List bundled research skills actually available in this backend.",json!({}),json!([])),
        spec("research_skill_read","Read a bundled research skill before working in its area.",json!({"name":{"type":"string"}}),json!(["name"])),
        spec("research_document_list","List Markdown research plan files in this conversation.",json!({}),json!([])),
        spec("research_document_read","Read the actual plan and current hash before revising.",json!({"id":{"type":"string"}}),json!(["id"])),
        spec("research_document_write","Save the authoritative Markdown plan in the current project. Include verified citations, alternatives, recommendation, experiment steps, evaluation, compute constraints and open questions. Creation: id/expected_hash=null and unique request_id (letters, digits, dash, underscore). Update: existing id, current hash, new request_id. Identical retries reuse request_id. On conflict re-read and reconcile.",json!({"id":{"type":["string","null"]},"expected_hash":{"type":["string","null"]},"request_id":{"type":"string"},"title":{"type":"string"},"markdown":{"type":"string"}}),json!(["id","expected_hash","request_id","title","markdown"]))
    ]);
    tools
}

pub async fn execute(
    store: &Store,
    conversation: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value> {
    let c = store
        .conversation(conversation)
        .await?
        .ok_or_else(|| anyhow!("NOT_FOUND"))?;
    let project = c["project_id"]
        .as_str()
        .ok_or_else(|| anyhow!("NOT_FOUND"))?;
    if tool == "research_control_get" {
        if arguments != json!({}) { bail!("INVALID_RESEARCH_REQUEST"); }
        return crate::research_control::get(store,project,conversation).await;
    }
    if tool == "research_skill_list" {
        if arguments != json!({}) { bail!("INVALID_RESEARCH_REQUEST"); }
        return Ok(crate::agent_resources::list());
    }
    if tool == "research_skill_read" {
        if arguments.as_object().is_none_or(|o| o.len() != 1) { bail!("INVALID_RESEARCH_REQUEST"); }
        return crate::agent_resources::read(arguments["name"].as_str().ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?);
    }
    if tool.starts_with("research_document_") {
        let (action,allowed):(&str,&[&str])=match tool {
            "research_document_list"=>("list",&[]),
            "research_document_read"=>("read",&["id"]),
            "research_document_write"=>("write",&["id","expected_hash","request_id","title","markdown"]),
            _=>bail!("UNKNOWN_RESEARCH_TOOL")
        };
        if arguments.as_object().is_none_or(|v|v.len()!=allowed.len()||v.keys().any(|k|!allowed.contains(&k.as_str()))) {bail!("INVALID_PLAN_REQUEST");}
        return crate::research_documents::execute(store,project,conversation,action,arguments).await;
    }
    let object = arguments
        .as_object()
        .ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?;
    if arguments.to_string().len() > 300000 {
        bail!("INVALID_RESEARCH_REQUEST");
    }
    let allowed: &[&str] = match tool {
        "research_list" => &[],
        "research_get" => &["research_id"],
        "research_create" => &[
            "request_id",
            "title",
            "objective",
            "evaluation",
            "constraints",
            "plan",
        ],
        "research_update" => &[
            "research_id",
            "expected_revision",
            "title",
            "objective",
            "evaluation",
            "constraints",
            "plan",
        ],
        _ => bail!("UNKNOWN_RESEARCH_TOOL"),
    };
    if object.len() != allowed.len() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        bail!("INVALID_RESEARCH_REQUEST");
    }
    let path = format!("projects/{project}/research");
    let query = HashMap::from([("conversation_id".to_string(), conversation.to_string())]);
    if tool == "research_list" {
        return research::dispatch(store, &Method::GET, &path, &query, &Value::Null)
            .await
            .unwrap();
    }
    if tool != "research_create" {
        let id = arguments["research_id"]
            .as_str()
            .filter(|id| !id.is_empty() && !id.contains('/') && id.len() <= 128)
            .ok_or_else(|| anyhow!("INVALID_RESEARCH_REQUEST"))?;
        let item = format!("{path}/{id}");
        let current = research::dispatch(store, &Method::GET, &item, &query, &Value::Null)
            .await
            .unwrap()?;
        if current["origin_conversation_id"] != conversation {
            bail!("NOT_FOUND");
        }
        if tool == "research_get" {
            return Ok(current);
        }
        let mut body = arguments.clone();
        body.as_object_mut().unwrap().remove("research_id");
        if !body["plan"]
            .as_array()
            .is_some_and(|steps| !steps.is_empty())
        {
            bail!("INVALID_RESEARCH_REQUEST");
        }
        return research::dispatch(store, &Method::PATCH, &item, &query, &body)
            .await
            .unwrap();
    }
    let mut body = arguments;
    if !body["plan"]
        .as_array()
        .is_some_and(|steps| !steps.is_empty())
    {
        bail!("INVALID_RESEARCH_REQUEST");
    }
    body["origin_conversation_id"] = json!(conversation);
    research::dispatch(store, &Method::POST, &path, &query, &body)
        .await
        .unwrap()
}

pub fn response(result: Result<Value>) -> Value {
    let success = result.is_ok();
    let content = match result {
        Ok(data) => json!({"data":data}),
        Err(error) => {
            let code = error.to_string();
            json!({"code":if code.chars().all(|c|c.is_ascii_uppercase() || c == '_') {code} else {"RESEARCH_TOOL_FAILED".into()}})
        }
    };
    json!({"success":success,"contentItems":[{"type":"inputText","text":content.to_string()}]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn tools_bind_scope_preserve_plan_and_reject_conflicts() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::open(&dir.path().join("test.sqlite"))?;
        for (id, p) in [("a", "p"), ("b", "p"), ("c", "q")] {
            store
                .save_conversation(json!({"id":id,"project_id":p,"extra":{"workspace":"fixture"}}))
                .await?;
        }
        let fields = json!({"request_id":"one","title":"测试","objective":"baseline","evaluation":"fixed","constraints":"CPU","plan":["Inspect code","Define baseline"]});
        let goal = execute(&store, "a", "research_create", fields.clone()).await?;
        assert_eq!(
            execute(&store, "a", "research_create", fields.clone()).await?,
            goal
        );
        for other in ["b", "c"] {
            assert_eq!(
                execute(
                    &store,
                    other,
                    "research_get",
                    json!({"research_id":goal["id"]})
                )
                .await
                .unwrap_err()
                .to_string(),
                "NOT_FOUND"
            );
        }
        let mut spoof = fields.clone();
        spoof["project_id"] = json!("q");
        assert!(execute(&store, "a", "research_create", spoof)
            .await
            .is_err());
        let mut edit = fields;
        edit.as_object_mut().unwrap().remove("request_id");
        edit["research_id"] = goal["id"].clone();
        edit["expected_revision"] = json!(1);
        edit["plan"] = json!(["Revised plan"]);
        assert_eq!(execute(&store, "b", "research_update", edit.clone()).await.unwrap_err().to_string(), "NOT_FOUND");
        assert_eq!(
            execute(&store, "a", "research_update", edit.clone()).await?["revision"],
            2
        );
        assert_eq!(
            execute(&store, "a", "research_update", edit)
                .await
                .unwrap_err()
                .to_string(),
            "RESEARCH_REVISION_CONFLICT"
        );
        let listed = execute(&store, "a", "research_list", json!({})).await?;
        assert_eq!(listed[0]["plan"][0], "Revised plan");
        let manual = json!({"expected_revision":2,"title":"manual review","objective":"baseline","evaluation":"fixed","constraints":"CPU"});
        let path = format!("projects/p/research/{}",goal["id"].as_str().unwrap());
        let updated = research::dispatch(&store,&Method::PATCH,&path,&HashMap::new(),&manual).await.unwrap()?;
        assert_eq!(updated["plan"][0],"Revised plan");
        let mut invalid = manual; invalid["expected_revision"] = json!(3); invalid["plan"] = json!([""]);
        assert!(research::dispatch(&store,&Method::PATCH,&path,&HashMap::new(),&invalid).await.unwrap().is_err());
        assert!(execute(&store, "a", "research_run", json!({}))
            .await
            .is_err());
        Ok(())
    }
}
