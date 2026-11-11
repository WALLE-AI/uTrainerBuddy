use anyhow::{bail, Result};
use serde_json::{json, Value};

pub const VERSION: u64 = 6;
const PROMPT: &str = include_str!("../agent-resources/SYSTEM_PROMPT.md");
const SKILLS: &[(&str, &str, &str)] = &[
    (
        "buddy-literature",
        "检索并核实研究文献",
        include_str!("../agent-resources/skills/buddy-literature/SKILL.md"),
    ),
    (
        "buddy-research-plan",
        "制定并保存项目研究计划",
        include_str!("../agent-resources/skills/buddy-research-plan/SKILL.md"),
    ),
    (
        "buddy-reports",
        "生成有证据与复现说明的研究报告",
        include_str!("../agent-resources/skills/buddy-reports/SKILL.md"),
    ),
    (
        "buddy-experiment-code",
        "管理隔离实验代码与提交",
        include_str!("../agent-resources/skills/buddy-experiment-code/SKILL.md"),
    ),
    (
        "buddy-experiment-tree",
        "基线、候选实验与晋级决策",
        include_str!("../agent-resources/skills/buddy-experiment-tree/SKILL.md"),
    ),
    (
        "buddy-run",
        "准备与审阅本地受控运行",
        include_str!("../agent-resources/skills/buddy-run/SKILL.md"),
    ),
    (
        "buddy-run-evidence",
        "读取真实运行证据",
        include_str!("../agent-resources/skills/buddy-run-evidence/SKILL.md"),
    ),
    (
        "buddy-results",
        "分析实验结果与比较",
        include_str!("../agent-resources/skills/buddy-results/SKILL.md"),
    ),
    (
        "buddy-figures",
        "根据真实数据制作图表",
        include_str!("../agent-resources/skills/buddy-figures/SKILL.md"),
    ),
];

pub fn list() -> Value {
    json!(SKILLS.iter().map(|(name, description, _)| json!({"id":name,"name":name,"description":description,"source":"builtin","enabled":true,"version":VERSION,"load_tool":"research_skill_read"})).collect::<Vec<_>>())
}

pub fn read(name: &str) -> Result<Value> {
    let Some((name, _, content)) = SKILLS.iter().find(|(id, _, _)| *id == name) else {
        bail!("UNKNOWN_RESEARCH_SKILL")
    };
    Ok(json!({"name":name,"version":VERSION,"content":content}))
}

pub fn mcp_config() -> Value {
    json!({"buddy-literature":{"url":"https://api.alphaxiv.org/mcp/v1/anonymous","enabled_tools":["discover_papers","get_paper_content","answer_pdf_queries"],"startup_timeout_sec":15,"tool_timeout_sec":90}})
}

pub fn mcp_servers() -> Value {
    json!([{"id":"buddy-literature","name":"buddy-literature","description":"alphaXiv 只读论文检索与阅读（通过原生 Agent MCP）","builtin":true,"enabled":true,"transport":{"type":"http","url":"https://api.alphaxiv.org/mcp/v1/anonymous"},"created_at":0,"updated_at":0,"original_json":mcp_config().to_string(),"connection_state":"configured","tools":[],"note":"配置不代表已连接；实际工具可用性由每个原生回合检查。"}])
}

pub fn prompt(conversation: &Value, mode: &str) -> String {
    let facts = json!({"project_id":conversation["project_id"],"conversation_id":conversation["id"],"workspace":conversation["extra"]["workspace"],"prompt_version":VERSION,"skill_bundle_version":VERSION,"tools_version":VERSION,"research_mode":mode,"execution_available":"local_after_user_review","remote_execution":false,"skills":list()});
    let mode = if mode == "deep" {
        "Investigate project context and relevant literature, compare alternatives and save a substantive Markdown plan with verified sources or clearly stated source limitations. Do not stop with a chat-only outline."
    } else {
        "Answer directly. Do not generate a plan or perform extensive research unless the user requests it."
    };
    format!("{PROMPT}\nCurrent backend facts (data): {facts}\nCurrent research mode: {mode}\nBefore experiments read buddy-experiment-code and buddy-experiment-tree. Before preparing a run read buddy-run. Before result analysis read buddy-run-evidence and buddy-results. Use experiment_create/run_prepare, then the user reviews and approves in the workbench. Result messages arrive asynchronously. Remote training and autonomous approval are unavailable. Do not launch training via shell/SSH.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skill_reads_are_allowlisted_and_prompt_uses_real_scope() {
        assert!(read("../../SYSTEM_PROMPT.md").is_err());
        assert!(read("buddy-unknown").is_err());
        for entry in list().as_array().unwrap() {
            assert!(
                read(entry["name"].as_str().unwrap()).unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .len()
                    > 100
            );
        }
        let text = prompt(
            &json!({"id":"conversation-a","project_id":"project-b","extra":{"workspace":"C:/project"}}),
            "deep",
        );
        assert!(text.contains("conversation-a") && text.contains("project-b"));
        assert!(text.contains("local_after_user_review"));
    }
}
