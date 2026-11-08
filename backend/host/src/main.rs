use std::{
    io::{BufRead, Read, Write},
    path::Path,
};
use trainerbuddy_host::{Host, MAX_FRAME};
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = args
        .windows(2)
        .find(|p| p[0] == "--root")
        .map(|p| p[1].as_str())
        .ok_or_else(|| anyhow::anyhow!("--root required"))?;
    let host = Host::new(Path::new(root))?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    loop {
        let mut line = Vec::new();
        if (&mut input)
            .take(MAX_FRAME + 1)
            .read_until(b'\n', &mut line)?
            == 0
        {
            break;
        }
        if line.len() as u64 > MAX_FRAME {
            break;
        }
        let request: serde_json::Value = serde_json::from_slice(&line)?;
        let id = request["id"].clone();
        let reply = match host.handle(request) {
            Ok(data) => serde_json::json!({"id":id,"data":data}),
            Err(e) => {
                let message = e.to_string();
                let code = if message.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
                    message
                } else {
                    "HOST_IO_ERROR".into()
                };
                serde_json::json!({"id":id,"error":code})
            }
        };
        serde_json::to_writer(&mut output, &reply)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
