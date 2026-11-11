//! Deterministic native-protocol peer for adapter tests. Never used by electron:dev.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn send(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn event(method: &str, params: Value) {
    send(json!({"method":method,"params":params}));
}
fn complete(text: &str, status: &str) {
    event(
        "item/agentMessage/delta",
        json!({"threadId":"thread","itemId":"message","delta":text}),
    );
    event(
        "item/completed",
        json!({"threadId":"thread","item":{"id":"message","type":"agentMessage","text":text}}),
    );
    event(
        "turn/completed",
        json!({"threadId":"thread","turn":{"id":"turn","status":status}}),
    );
}
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = &request["id"];
        match request["method"].as_str() {
            Some("initialize") => send(json!({"id":id,"result":{"userAgent":"fixture"}})),
            Some("initialized") => {}
            Some("thread/start" | "thread/resume") => {
                if request["method"] == "thread/start" {
                    for name in ["research_document_write", "research_skill_read", "run_prepare", "run_evidence"] {
                        assert!(request["params"]["dynamicTools"].as_array().unwrap().iter().any(|t|t["name"]==name));
                    }
                }
                assert!(request["params"]["developerInstructions"]
                    .as_str()
                    .unwrap()
                    .contains("research_create"));
                send(json!({"id":id,"result":{"thread":{"id":"thread"}}}))
            }
            Some("turn/start") => {
                send(json!({"id":id,"result":{"turn":{"id":"turn"}}}));
                let prompt = request["params"]["input"][0]["text"].as_str().unwrap();
                match prompt {
                    "document" => send(json!({"id":"document-write","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","callId":"document","tool":"research_document_write","arguments":{"id":null,"expected_hash":null,"request_id":"fixture-plan","title":"Research document","markdown":"# Research plan\n\n## Goal\nDeterministic baseline\n\n## Evidence\nProtocol fixture only; no external research.\n\n## Experiments\n1. Inspect context\n2. Fix evaluation\n3. Compare evidence\n"}}})),
                    "research" => send(
                        json!({"id":"research-create","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","callId":"create","tool":"research_create","arguments":{"request_id":"fixture-goal","title":"智能体研究计划","objective":"CPU baseline","evaluation":"fixed seed","constraints":"no training now","plan":["Inspect the project","Define a deterministic baseline"]}}}),
                    ),
                    "research-read" => send(
                        json!({"id":"research-read","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","callId":"list","tool":"research_list","arguments":{}}}),
                    ),
                    "research-stale" => send(
                        json!({"id":"research-stale","method":"item/tool/call","params":{"threadId":"wrong-thread","turnId":"turn","callId":"stale","tool":"research_list","arguments":{}}}),
                    ),
                    "approval" => {
                        event(
                            "turn/plan/updated",
                            json!({"threadId":"thread","plan":[{"step":"检查项目","status":"inProgress"}]}),
                        );
                        event(
                            "item/started",
                            json!({"threadId":"thread","item":{"type":"commandExecution","id":"command","command":"echo fixture","status":"inProgress"}}),
                        );
                        send(
                            json!({"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thread","command":"echo fixture","reason":"test approval"}}),
                        );
                    }
                    "question" => send(
                        json!({"id":"question-1","method":"item/tool/requestUserInput","params":{"threadId":"thread","questions":[{"id":"goal","header":"目标","question":"选择目标？","options":null},{"id":"metric","question":"选择指标？","options":[{"label":"准确率","description":"Accuracy"}]}]}}),
                    ),
                    "wait" => {}
                    "crash" => std::process::exit(3),
                    _ => complete("你好，fixture", "completed"),
                }
            }
            Some("turn/interrupt") => {
                send(json!({"id":id,"result":{}}));
                complete("已停止", "interrupted");
            }
            None if id == "approval-1" => {
                event(
                    "serverRequest/resolved",
                    json!({"threadId":"thread","requestId":id}),
                );
                event(
                    "item/completed",
                    json!({"threadId":"thread","item":{"type":"commandExecution","id":"command","command":"echo fixture","status":"completed","aggregatedOutput":"fixture","exitCode":0}}),
                );
                complete(request["result"]["decision"].as_str().unwrap(), "completed");
            }
            None if id == "research-create" => {
                assert_eq!(request["result"]["success"], true);
                let payload: Value = serde_json::from_str(
                    request["result"]["contentItems"][0]["text"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                let goal = &payload["data"];
                let args = json!({"research_id":goal["id"],"expected_revision":goal["revision"],"title":goal["title"],"objective":goal["objective"],"evaluation":goal["evaluation"],"constraints":goal["constraints"],"plan":["Inspect the project","Define a deterministic baseline","Compare measured evidence"]});
                send(
                    json!({"id":"research-update","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","callId":"update","tool":"research_update","arguments":args}}),
                );
            }
            None if id == "research-update" || id == "research-read" || id == "document-write" => {
                assert_eq!(request["result"]["success"], true);
                complete(
                    request["result"]["contentItems"][0]["text"]
                        .as_str()
                        .unwrap(),
                    "completed",
                );
            }
            None if id == "research-stale" => {
                assert_eq!(request["result"]["success"], false);
                complete("stale request rejected", "completed");
            }
            None if id == "question-1" => {
                event(
                    "serverRequest/resolved",
                    json!({"threadId":"thread","requestId":id}),
                );
                complete(&request["result"].to_string(), "completed");
            }
            _ => send(json!({"id":id,"error":{"code":-32601,"message":"unknown fixture method"}})),
        }
    }
}
