pub mod codex;
mod process_group;

use serde_json::{json, Value};

/// Native protocols belong to adapters; existing renderer event types are compatibility DTOs.
pub fn capabilities(codex_installed: bool) -> Value {
    json!({"engines":[
        {"id":"codex","protocol":"app-server/stdio","implemented":true,"installed":codex_installed,
         "streaming":true,"resume":true,"interrupt":true,"approvals":true,"questions":true,"midturn_delivery":false},
        {"id":"claude-code","protocol":"stream-json","implemented":false},
        {"id":"opencode","protocol":"http-sse","implemented":false},
        {"id":"deepseek-harness","protocol":null,"implemented":false}
    ],"training":false,"ssh":false})
}
