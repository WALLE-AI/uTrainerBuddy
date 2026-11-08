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
                send(json!({"id":id,"result":{"thread":{"id":"thread"}}}))
            }
            Some("turn/start") => {
                send(json!({"id":id,"result":{"turn":{"id":"turn"}}}));
                let prompt = request["params"]["input"][0]["text"].as_str().unwrap();
                match prompt {
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
