use serde_json::{json, Value};
use std::{fs, io::Cursor, path::Path};
use trainerbuddy_host::{archive_manifest, digest, encode, Host};

fn archive(path: &Path, files: &[(&str, &[u8])]) {
    let mut builder = tar::Builder::new(fs::File::create(path).unwrap());
    let global = b"13 comment=x\n";
    let mut h = tar::Header::new_ustar();
    h.set_entry_type(tar::EntryType::new(b'g'));
    h.set_size(global.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    builder
        .append_data(&mut h, "pax_global_header", Cursor::new(global))
        .unwrap();
    for (path, bytes) in files {
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        builder
            .append_data(&mut h, path, Cursor::new(bytes))
            .unwrap();
    }
    builder.finish().unwrap();
}
fn put(host: &Host, bytes: &[u8], sha: &str) {
    host.handle(json!({"op":"put_chunk","project":"p1","sha256":sha,"size":bytes.len(),"offset":0,"bytes":encode(bytes)})).unwrap();
    host.handle(json!({"op":"complete_blob","project":"p1","sha256":sha,"size":bytes.len()}))
        .unwrap();
}
#[test]
fn publish_versions_are_isolated_verified_and_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::new(dir.path()).unwrap();
    let input = dir.path().join("input.tar");
    archive(
        &input,
        &[
            ("nested/config.json", b"{\"ok\":true}\n"),
            ("empty.txt", b""),
        ],
    );
    let bytes = fs::read(&input).unwrap();
    let sha = digest(&bytes);
    let manifest = archive_manifest(&input).unwrap();
    put(&host, &bytes, &sha);
    let request = json!({"op":"publish_snapshot","project":"p1","snapshot":"version_a","sha256":sha,"manifest":manifest,"commit":"commit-a"});
    let result = host.handle(request.clone()).unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(host.handle(request).unwrap(), result);
    let repo = dir.path().join(result["repo_path"].as_str().unwrap());
    assert_eq!(
        fs::read(repo.join("nested/config.json")).unwrap(),
        b"{\"ok\":true}\n"
    );
    let read=host.handle(json!({"op":"read_chunk","project":"p1","path":format!("{}/nested/config.json",result["repo_path"].as_str().unwrap()),"offset":0})).unwrap();
    assert_eq!(read["sha256"], digest(b"{\"ok\":true}\n"));
    assert!(host
        .handle(json!({"op":"read_chunk","project":"p1","path":"../outside"}))
        .is_err());
    archive(&input, &[("next.txt", b"next")]);
    let bytes2 = fs::read(&input).unwrap();
    let sha2 = digest(&bytes2);
    put(&host, &bytes2, &sha2);
    assert!(host.handle(json!({"op":"publish_snapshot","project":"p1","snapshot":"version_a","sha256":sha2,"manifest":archive_manifest(&input).unwrap()})).is_err());
    assert_eq!(
        fs::read(repo.join("nested/config.json")).unwrap(),
        b"{\"ok\":true}\n"
    );
}
#[test]
fn chunks_resume_reject_conflicting_retries_and_recover_corruption() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::new(dir.path()).unwrap();
    let sha = digest(b"abcdef");
    let req = |offset: u64, bytes: &[u8]| json!({"op":"put_chunk","project":"p1","sha256":sha,"size":6,"offset":offset,"bytes":encode(bytes)});
    assert_eq!(host.handle(req(0, b"abc")).unwrap()["offset"], 3);
    assert_eq!(host.handle(req(0, b"abc")).unwrap()["offset"], 3);
    assert!(host.handle(req(0, b"xyz")).is_err());
    let restarted = Host::new(dir.path()).unwrap();
    assert_eq!(
        restarted
            .handle(json!({"op":"has_blob","project":"p1","sha256":sha,"size":6}))
            .unwrap()["offset"],
        3
    );
    restarted.handle(req(3, b"def")).unwrap();
    restarted
        .handle(json!({"op":"complete_blob","project":"p1","sha256":sha,"size":6}))
        .unwrap();
    let other = digest(b"123456");
    restarted.handle(json!({"op":"put_chunk","project":"p1","sha256":other,"size":6,"offset":0,"bytes":encode(b"xxxxxx")})).unwrap();
    assert!(restarted
        .handle(json!({"op":"complete_blob","project":"p1","sha256":other,"size":6}))
        .is_err());
    assert_eq!(
        restarted
            .handle(json!({"op":"has_blob","project":"p1","sha256":other,"size":6}))
            .unwrap()["offset"],
        0
    );
}
#[test]
fn archives_reject_credentials_links_and_manifest_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.tar");
    archive(&input, &[(".env", b"SECRET=value")]);
    assert!(archive_manifest(&input).is_err());
    let mut builder = tar::Builder::new(fs::File::create(&input).unwrap());
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Symlink);
    h.set_size(0);
    h.set_mode(0o777);
    h.set_link_name("../../outside").unwrap();
    h.set_cksum();
    builder
        .append_data(&mut h, "link", Cursor::new([]))
        .unwrap();
    builder.finish().unwrap();
    drop(builder);
    assert!(archive_manifest(&input).is_err());
    archive(&input, &[("safe.txt", b"safe")]);
    let host = Host::new(dir.path()).unwrap();
    let bytes = fs::read(&input).unwrap();
    let sha = digest(&bytes);
    put(&host, &bytes, &sha);
    assert!(host.handle(json!({"op":"publish_snapshot","project":"p1","snapshot":"bad","sha256":sha,"manifest":Vec::<Value>::new()})).is_err());
    assert!(!dir
        .path()
        .join(".trainerbuddy/projects/p1/releases/bad")
        .exists());
}
#[cfg(unix)]
#[test]
fn linux_managed_writes_refuse_symlinks_and_hardlinks() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), dir.path().join(".trainerbuddy")).unwrap();
    let host = Host::new(dir.path()).unwrap();
    assert!(host
        .handle(json!({"op":"has_blob","project":"p1","sha256":digest(b"x"),"size":1}))
        .is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_file(dir.path().join(".trainerbuddy")).unwrap();
    let file = dir.path().join("outside.txt");
    fs::write(&file, "do not modify").unwrap();
    let root = trainerbuddy_host::SafeRoot::open(dir.path()).unwrap();
    let _ = root.file("owned/placeholder", true).unwrap();
    fs::hard_link(&file, dir.path().join("owned/linked")).unwrap();
    assert!(root.file("owned/linked", true).is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), "do not modify");
}
