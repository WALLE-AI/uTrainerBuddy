//! A subprocess fixture verifies the actual argv/stdin boundary, without a network dependency.
use serde_json::json;
use std::io::{BufRead, Write};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if let Some(known_hosts) = std::env::var_os("TRAINERBUDDY_REAL_SSH_KNOWN_HOSTS") {
        // Real client, isolated trust file; stdin/stdout remain the actual probe transport.
        let mut client = std::process::Command::new("ssh");
        client
            .arg("-o")
            .arg(format!(
                "UserKnownHostsFile={}",
                known_hosts.to_string_lossy()
            ))
            .args(["-o", "GlobalKnownHostsFile=none"])
            .args(args.iter().skip(1));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            client.creation_flags(0x08000000);
        }
        let status = client.status().unwrap();
        std::process::exit(status.code().unwrap_or(1));
    }
    for option in [
        "StrictHostKeyChecking=yes",
        "PermitLocalCommand=no",
        "ClearAllForwardings=yes",
    ] {
        assert!(args.iter().any(|arg| arg == option), "missing {option}");
    }
    assert_eq!(
        args.last().unwrap(),
        "python3 -u -c 'import sys; exec(sys.stdin.readline())'"
    );
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut input = String::new();
    input.push_str(&lines.next().unwrap().unwrap());
    assert!(input.starts_with("exec("));
    assert!(input.contains("CONFIG = "));
    let password_mode = args.iter().any(|arg| arg == "BatchMode=no");
    if password_mode {
        let expected = "fixture password ! $ ' space";
        assert!(!input.contains(expected));
        assert!(!args.iter().any(|arg| arg.contains(expected)));
        assert!(!std::env::vars().any(|(_, value)| value.contains(expected)));
        assert!(args.iter().any(|arg| arg == "NumberOfPasswordPrompts=1"));
        let answer = std::process::Command::new(std::env::var_os("SSH_ASKPASS").unwrap())
            .arg("researcher@lab-alias's password:")
            .output()
            .unwrap();
        assert!(answer.status.success());
        assert_eq!(
            String::from_utf8(answer.stdout).unwrap().trim_end(),
            expected
        );
    } else {
        assert!(args.iter().any(|arg| arg == "BatchMode=yes"));
    }
    let mode = std::fs::read_to_string(std::env::var_os("TRAINERBUDDY_SSH_FIXTURE_MODE").unwrap())
        .unwrap();
    match mode.as_str() {
        "auth" => {
            eprintln!("Permission denied (publickey).");
            std::process::exit(255);
        }
        "trust" => {
            eprintln!("Host key verification failed.");
            std::process::exit(255);
        }
        "changed" => {
            eprintln!("REMOTE HOST IDENTIFICATION HAS CHANGED!");
            std::process::exit(255);
        }
        "invalid" => {
            println!("not json");
            return;
        }
        "slow" => std::thread::sleep(std::time::Duration::from_millis(900)),
        _ => {}
    }
    println!(
        "{}",
        json!({"protocol_version":1,"hostname":"fixture-gpu","os":"Linux","arch":"x86_64","python":"3.12.0",
        "gpus":[{"uuid":"GPU-test","name":"Fixture GPU","memory_total_mib":24576,"memory_free_mib":22000,"driver":"fixture"}],
        "gpu_error":null,"workdir":{"path":"/workspace","exists":true,"writable":true},"host":{"installed":false,"ready":false,"protocol_version":null}})
    );
    std::io::stdout().flush().unwrap();
    if mode == "close-idle" {
        return;
    }
    let remote_root =
        std::env::var_os("TRAINERBUDDY_TEST_REMOTE_ROOT").map(std::path::PathBuf::from);
    let mut native_host: Option<(
        std::process::Child,
        std::process::ChildStdin,
        std::io::BufReader<std::process::ChildStdout>,
    )> = None;
    let mut package = Vec::new();
    let mut package_sha = String::new();
    for line in lines {
        let request: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if let Some(root) = &remote_root {
            let op = request["op"].as_str().unwrap_or("");
            let mut error = None;
            let data = match op {
                "host_install_begin" => {
                    package.clear();
                    package_sha = request["sha256"].as_str().unwrap().into();
                    serde_json::json!({"offset":0})
                }
                "host_install_chunk" => {
                    package.extend(
                        trainerbuddy_host::decode(request["bytes"].as_str().unwrap()).unwrap(),
                    );
                    serde_json::json!({"offset":package.len()})
                }
                "host_install_finish" => {
                    assert_eq!(trainerbuddy_host::digest(&package), package_sha);
                    let mut command = std::process::Command::new(
                        std::env::var_os("TRAINERBUDDY_TEST_HOST_BIN").unwrap(),
                    );
                    command
                        .args(["serve", "--root"])
                        .arg(root)
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::null());
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        command.creation_flags(0x08000000);
                    }
                    let mut child = command.spawn().unwrap();
                    let input = child.stdin.take().unwrap();
                    let output = std::io::BufReader::new(child.stdout.take().unwrap());
                    native_host = Some((child, input, output));
                    serde_json::json!({"started":true})
                }
                "host_request" => {
                    if let Some((_, input, output)) = &mut native_host {
                        writeln!(input, "{}", request["request"]).unwrap();
                        input.flush().unwrap();
                        let mut line = String::new();
                        output.read_line(&mut line).unwrap();
                        let response: serde_json::Value = serde_json::from_str(&line).unwrap();
                        if request["request"]["op"] == "put_chunk" {
                            let fault = std::fs::read_to_string(
                                std::env::var_os("TRAINERBUDDY_SSH_FIXTURE_MODE").unwrap(),
                            )
                            .unwrap();
                            if fault == "drop-upload" {
                                return;
                            }
                            if fault == "slow-upload" {
                                std::thread::sleep(std::time::Duration::from_millis(100));
                            }
                        }
                        if response["error"].is_string() {
                            serde_json::json!({"host_error":response["error"]})
                        } else {
                            let mut data = response["data"].clone();
                            if request["request"]["op"] == "hello" {
                                data["binary_sha256"] = serde_json::json!(package_sha);
                            }
                            data
                        }
                    } else {
                        error = Some("HOST_NOT_READY");
                        serde_json::Value::Null
                    }
                }
                "list" => {
                    let entries:Vec<_>=std::fs::read_dir(root.join(request["path"].as_str().unwrap_or(""))).unwrap().map(|e|{let e=e.unwrap();serde_json::json!({"name":e.file_name().to_string_lossy(),"type":if e.file_type().unwrap().is_dir(){"dir"}else{"file"},"size":e.metadata().unwrap().len(),"symlink":false})}).collect();
                    serde_json::json!({"entries":entries,"next_cursor":null,"truncated":false,"root":root})
                }
                "read" => {
                    let bytes =
                        std::fs::read(root.join(request["path"].as_str().unwrap())).unwrap();
                    serde_json::json!({"content_base64":trainerbuddy_host::encode(&bytes),"size":bytes.len(),"modified_at":123,"path":request["path"]})
                }
                _ => serde_json::Value::Null,
            };
            println!(
                "{}",
                if let Some(code) = error {
                    serde_json::json!({"id":request["id"],"error":code})
                } else {
                    serde_json::json!({"id":request["id"],"data":data})
                }
            );
            std::io::stdout().flush().unwrap();
            continue;
        }
        if request["path"] == "__close" {
            return;
        }
        if request["path"] == "denied" {
            println!(
                "{}",
                json!({"id":request["id"],"error":"REMOTE_FILE_PERMISSION_DENIED"})
            );
            std::io::stdout().flush().unwrap();
            continue;
        }
        let data = if request["op"] == "list" {
            json!({"entries":[{"name":"readme.txt","type":"file","size":6,"symlink":false}],"next_cursor":null,"truncated":false,"root":"/workspace"})
        } else {
            json!({"content_base64":"aGVsbG8K","size":6,"modified_at":123,"path":request["path"]})
        };
        println!("{}", json!({"id":request["id"],"data":data}));
        std::io::stdout().flush().unwrap();
    }
}
