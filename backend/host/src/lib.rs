use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

pub const PROTOCOL: u32 = 1;
pub const CHUNK: usize = 256 * 1024;
pub const MAX_FRAME: u64 = 8 * 1024 * 1024;
pub const MAX_SOURCE: u64 = 256 * 1024 * 1024;
pub fn encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
pub fn decode(text: &str) -> Result<Vec<u8>> {
    Ok(STANDARD.decode(text)?)
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn file_digest(file: &mut File) -> Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(format!("{:x}", hash.finalize()))
}
pub fn id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        bail!("INVALID_ID");
    }
    Ok(value)
}
pub fn sha(value: &str) -> Result<&str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        bail!("INVALID_DIGEST");
    }
    Ok(value)
}
pub fn relative(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains(['\\', '\0', ':'])
        || !Path::new(value)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
    {
        bail!("PATH_OUTSIDE_WORKSPACE");
    }
    Ok(value)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SourceEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub executable: bool,
}
pub fn archive_manifest(path: &Path) -> Result<Vec<SourceEntry>> {
    let mut archive = tar::Archive::new(File::open(path)?);
    let mut entries = vec![];
    let mut names = BTreeSet::new();
    let mut total = 0;
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_pax_global_extensions() {
            continue;
        }
        let path = entry
            .path()?
            .to_str()
            .ok_or_else(|| anyhow!("UNSUPPORTED_FILENAME"))?
            .trim_end_matches('/')
            .to_owned();
        relative(&path)?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            bail!("SNAPSHOT_UNSUPPORTED_ENTRY");
        }
        if !names.insert(path.to_lowercase()) {
            bail!("SNAPSHOT_PATH_COLLISION");
        }
        if path
            .split('/')
            .any(|p| matches!(p, ".git" | ".ssh" | ".aws" | ".data"))
            || path.split('/').next_back().is_some_and(|name| {
                (name == ".env" || name.starts_with(".env.")) && name != ".env.example"
                    || matches!(name, "id_rsa" | "id_ed25519")
                    || name.ends_with(".pem")
                    || name.ends_with(".p12")
            })
        {
            bail!("SNAPSHOT_CREDENTIAL_FILE");
        }
        let size = entry.size();
        total += size;
        if size > 32 * 1024 * 1024 || total > MAX_SOURCE || entries.len() >= 20000 {
            bail!("SNAPSHOT_TOO_LARGE");
        }
        let executable = entry.header().mode()? & 0o111 != 0;
        let mut hash = Sha256::new();
        let mut buf = [0; 65536];
        let mut first = true;
        loop {
            let n = entry.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if first && buf[..n].starts_with(b"version https://git-lfs.github.com/spec/v1") {
                bail!("SNAPSHOT_LFS_POINTER");
            }
            first = false;
            hash.update(&buf[..n]);
        }
        entries.push(SourceEntry {
            path,
            size,
            sha256: format!("{:x}", hash.finalize()),
            executable,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Directory handles pin the selected root. Every write parent is opened without following links.
pub struct SafeRoot {
    pub path: PathBuf,
    #[cfg_attr(windows, allow(dead_code))]
    directory: File,
}
impl SafeRoot {
    pub fn open(path: &Path) -> Result<Self> {
        let _original = path;
        let path = path.canonicalize()?;
        #[cfg(unix)]
        let directory = {
            use std::os::{fd::BorrowedFd, unix::fs::OpenOptionsExt};
            if let Some(number) = _original
                .to_str()
                .and_then(|p| p.strip_prefix("/proc/self/fd/"))
                .and_then(|p| p.parse::<i32>().ok())
            {
                File::from(unsafe { BorrowedFd::borrow_raw(number) }.try_clone_to_owned()?)
            } else {
                OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&path)?
            }
        };
        #[cfg(windows)]
        let directory = {
            use std::os::windows::fs::OpenOptionsExt;
            OpenOptions::new()
                .read(true)
                .custom_flags(0x02000000)
                .open(&path)?
        };
        Ok(Self { path, directory })
    }
    fn directory(&self, path: &str, create: bool) -> Result<File> {
        if !path.is_empty() {
            relative(path)?;
        }
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::fs::MetadataExt;
            let mut directory = self.directory.try_clone()?;
            for name in path.split('/').filter(|s| !s.is_empty()) {
                let name = std::ffi::CString::new(name)?;
                if create {
                    let rc = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                    if rc < 0
                        && std::io::Error::last_os_error().kind()
                            != std::io::ErrorKind::AlreadyExists
                    {
                        return Err(std::io::Error::last_os_error().into());
                    }
                }
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    bail!("PATH_OUTSIDE_WORKSPACE");
                }
                directory = unsafe { File::from_raw_fd(fd) };
                let m = directory.metadata()?;
                if create && (m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0) {
                    bail!("UNSAFE_MANAGED_DIRECTORY");
                }
            }
            Ok(directory)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let mut target = self.path.clone();
            for name in path.split('/').filter(|s| !s.is_empty()) {
                target.push(name);
                if create && !target.exists() {
                    fs::create_dir(&target)?;
                }
                if fs::symlink_metadata(&target)?.file_type().is_symlink() {
                    bail!("PATH_OUTSIDE_WORKSPACE");
                }
            }
            Ok(OpenOptions::new()
                .read(true)
                .custom_flags(0x02000000)
                .open(target)?)
        }
    }
    pub fn file(&self, path: &str, write: bool) -> Result<File> {
        relative(path)?;
        let (parent, _name) = path.rsplit_once('/').unwrap_or(("", path));
        let directory = self.directory(parent, write)?;
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(_name)?;
            let flags = if write {
                libc::O_RDWR | libc::O_CREAT
            } else {
                libc::O_RDONLY
            };
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let file = unsafe { File::from_raw_fd(fd) };
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                bail!("UNSUPPORTED_FILE_TYPE");
            }
            if write {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.mode() & 0o022 != 0
                    || metadata.nlink() != 1
                {
                    bail!("UNSAFE_MANAGED_DIRECTORY");
                }
            }
            Ok(file)
        }
        #[cfg(windows)]
        {
            let _ = directory;
            let target = self.path.join(path);
            if target.exists() && fs::symlink_metadata(&target)?.file_type().is_symlink() {
                bail!("PATH_OUTSIDE_WORKSPACE");
            }
            let f = OpenOptions::new()
                .read(true)
                .write(write)
                .create(write)
                .truncate(false)
                .open(target)?;
            if !f.metadata()?.is_file() {
                bail!("UNSUPPORTED_FILE_TYPE");
            }
            Ok(f)
        }
    }
    fn publish_rename(&self, from: &str, to: &str) -> Result<()> {
        relative(from)?;
        relative(to)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let (fp, fnm) = from.rsplit_once('/').unwrap_or(("", from));
            let (tp, tnm) = to.rsplit_once('/').unwrap_or(("", to));
            let fd = self.directory(fp, false)?;
            let td = self.directory(tp, true)?;
            let fnm = std::ffi::CString::new(fnm)?;
            let tnm = std::ffi::CString::new(tnm)?;
            if unsafe { libc::renameat(fd.as_raw_fd(), fnm.as_ptr(), td.as_raw_fd(), tnm.as_ptr()) }
                < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            td.sync_all()?;
            Ok(())
        }
        #[cfg(windows)]
        {
            fs::rename(self.path.join(from), self.path.join(to))?;
            Ok(())
        }
    }
    fn exists(&self, path: &str) -> bool {
        self.file(path, false).is_ok()
    }
    fn json(&self, path: &str) -> Result<Value> {
        Ok(serde_json::from_reader(self.file(path, false)?)?)
    }
    fn write_json(&self, path: &str, value: &Value) -> Result<()> {
        let tmp = format!("{path}.part");
        let mut f = self.file(&tmp, true)?;
        f.set_len(0)?;
        f.write_all(&serde_json::to_vec(value)?)?;
        f.sync_all()?;
        drop(f);
        self.publish_rename(&tmp, path)
    }
}

pub struct Host {
    root: SafeRoot,
    read_cache: std::sync::Mutex<std::collections::HashMap<String, (String, String)>>,
}
impl Host {
    pub fn new(path: &Path) -> Result<Self> {
        Ok(Self {
            root: SafeRoot::open(path)?,
            read_cache: std::sync::Mutex::new(Default::default()),
        })
    }
    pub fn handle(&self, request: Value) -> Result<Value> {
        let op = request["op"].as_str().unwrap_or("");
        if op == "hello" {
            return Ok(
                json!({"protocol_version":PROTOCOL,"arch":std::env::consts::ARCH,"binary_sha256":file_digest(&mut File::open(std::env::current_exe()?)?)?,"capabilities":["snapshot_publish","read_chunk"]}),
            );
        }
        let project = id(request["project"].as_str().unwrap_or(""))?;
        let subdir = request["managed_subdir"].as_str().unwrap_or("");
        if !subdir.is_empty() {
            relative(subdir)?;
        }
        let base = format!(
            "{}.trainerbuddy/projects/{project}",
            if subdir.is_empty() {
                String::new()
            } else {
                format!("{subdir}/")
            }
        );
        let lock = self.root.file(&format!("{base}/host.lock"), true)?;
        lock.try_lock_exclusive()
            .map_err(|_| anyhow!("HOST_BUSY"))?;
        match op {
            "has_blob" | "put_chunk" | "complete_blob" => {
                let sha = sha(request["sha256"].as_str().unwrap_or(""))?;
                let total = request["size"]
                    .as_u64()
                    .filter(|n| *n <= MAX_SOURCE)
                    .ok_or_else(|| anyhow!("SNAPSHOT_TOO_LARGE"))?;
                let final_path = format!("{base}/sources/{sha}");
                let part = format!("{final_path}.part");
                if self.root.exists(&final_path) {
                    let mut f = self.root.file(&final_path, false)?;
                    if f.metadata()?.len() != total || file_digest(&mut f)? != sha {
                        bail!("DIGEST_MISMATCH");
                    }
                    return Ok(json!({"complete":true,"offset":total}));
                }
                let mut file = self.root.file(&part, true)?;
                if op == "has_blob"
                    && file.metadata()?.len() == total
                    && file_digest(&mut file)? != sha
                {
                    file.set_len(0)?;
                    file.sync_data()?;
                }
                if op == "put_chunk" {
                    let offset = request["offset"]
                        .as_u64()
                        .ok_or_else(|| anyhow!("INVALID_OFFSET"))?;
                    let bytes = decode(request["bytes"].as_str().unwrap_or(""))?;
                    let len = file.metadata()?.len();
                    if bytes.len() > CHUNK
                        || offset > len
                        || offset
                            .checked_add(bytes.len() as u64)
                            .is_none_or(|n| n > total)
                    {
                        bail!("INVALID_OFFSET");
                    }
                    let overlap = (len - offset).min(bytes.len() as u64) as usize;
                    let mut prior = vec![0; overlap];
                    file.seek(SeekFrom::Start(offset))?;
                    file.read_exact(&mut prior)?;
                    if prior != bytes[..overlap] {
                        bail!("CHUNK_CONFLICT");
                    }
                    file.seek(SeekFrom::Start(offset + overlap as u64))?;
                    file.write_all(&bytes[overlap..])?;
                    file.sync_data()?;
                }
                if op == "complete_blob" {
                    if file.metadata()?.len() != total || file_digest(&mut file)? != sha {
                        file.set_len(0)?;
                        file.sync_data()?;
                        bail!("DIGEST_MISMATCH");
                    }
                    file.sync_all()?;
                    drop(file);
                    self.root.publish_rename(&part, &final_path)?;
                    return Ok(json!({"complete":true,"offset":total}));
                }
                Ok(json!({"complete":false,"offset":file.metadata()?.len()}))
            }
            "inspect_release" | "publish_snapshot" => {
                let snapshot = id(request["snapshot"].as_str().unwrap_or(""))?;
                let sha = sha(request["sha256"].as_str().unwrap_or(""))?;
                let release = format!("{base}/releases/{snapshot}");
                let receipt = format!("{release}/receipt.json");
                if self.root.exists(&receipt) {
                    let result = self.root.json(&receipt)?;
                    if result["sha256"] != sha {
                        bail!("RELEASE_CONFLICT");
                    }
                    return Ok(result);
                }
                if op == "inspect_release" {
                    return Ok(json!({"complete":false}));
                }
                let archive_path = format!("{base}/sources/{sha}");
                let mut source = self.root.file(&archive_path, false)?;
                if file_digest(&mut source)? != sha {
                    bail!("DIGEST_MISMATCH");
                }
                let expected: Vec<SourceEntry> =
                    serde_json::from_value(request["manifest"].clone())?;
                let temp = format!("{base}/releases/{snapshot}.part");
                let _ = self.root.directory(&format!("{temp}/repo"), true)?;
                let identity = format!("{temp}/identity.json");
                if self.root.exists(&identity) {
                    if self.root.json(&identity)?["sha256"] != sha {
                        bail!("RELEASE_CONFLICT");
                    }
                } else {
                    self.root.write_json(&identity, &json!({"sha256":sha}))?;
                }
                let mut archive = tar::Archive::new(source);
                let mut actual = vec![];
                let mut names = BTreeSet::new();
                let mut total = 0;
                for entry in archive.entries()? {
                    let mut entry = entry?;
                    if entry.header().entry_type().is_pax_global_extensions() {
                        continue;
                    }
                    let path = entry
                        .path()?
                        .to_str()
                        .ok_or_else(|| anyhow!("UNSUPPORTED_FILENAME"))?
                        .trim_end_matches('/')
                        .to_owned();
                    relative(&path)?;
                    if entry.header().entry_type().is_dir() {
                        self.root.directory(&format!("{temp}/repo/{path}"), true)?;
                        continue;
                    }
                    if !entry.header().entry_type().is_file() || !names.insert(path.to_lowercase())
                    {
                        bail!("SNAPSHOT_UNSUPPORTED_ENTRY");
                    }
                    let size = entry.size();
                    total += size;
                    if size > 32 * 1024 * 1024 || total > MAX_SOURCE || actual.len() >= 20000 {
                        bail!("SNAPSHOT_TOO_LARGE");
                    }
                    let executable = entry.header().mode()? & 0o111 != 0;
                    let mut target = self.root.file(&format!("{temp}/repo/{path}"), true)?;
                    target.set_len(0)?;
                    let mut hash = Sha256::new();
                    let mut buf = [0; 65536];
                    loop {
                        let n = entry.read(&mut buf)?;
                        if n == 0 {
                            break;
                        }
                        hash.update(&buf[..n]);
                        target.write_all(&buf[..n])?;
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        target.set_permissions(fs::Permissions::from_mode(if executable {
                            0o700
                        } else {
                            0o600
                        }))?;
                    }
                    target.sync_all()?;
                    actual.push(SourceEntry {
                        path,
                        size,
                        sha256: format!("{:x}", hash.finalize()),
                        executable,
                    });
                }
                actual.sort_by(|a, b| a.path.cmp(&b.path));
                if actual != expected {
                    bail!("MANIFEST_MISMATCH");
                }
                let result = json!({"complete":true,"snapshot_id":snapshot,"sha256":sha,"file_count":actual.len(),"repo_path":format!("{release}/repo"),"commit":request["commit"],"manifest_sha256":digest(&serde_json::to_vec(&actual)?)});
                self.root
                    .write_json(&format!("{temp}/receipt.json"), &result)?;
                self.root.publish_rename(&temp, &release)?;
                Ok(result)
            }
            "read_chunk" => {
                let path = relative(request["path"].as_str().unwrap_or(""))?;
                let resolved = self.root.path.join(path).canonicalize()?;
                if !resolved.starts_with(&self.root.path) {
                    bail!("PATH_OUTSIDE_WORKSPACE");
                }
                let relative = resolved
                    .strip_prefix(&self.root.path)?
                    .to_str()
                    .ok_or_else(|| anyhow!("UNSUPPORTED_FILENAME"))?
                    .replace('\\', "/");
                let mut file = self.root.file(&relative, false)?;
                let metadata = file.metadata()?;
                let len = metadata.len();
                let identity = format!("{len}:{:?}", metadata.modified()?);
                #[cfg(unix)]
                let identity = {
                    use std::os::unix::fs::MetadataExt;
                    format!("{identity}:{}:{}", metadata.dev(), metadata.ino())
                };
                let cached = self
                    .read_cache
                    .lock()
                    .unwrap()
                    .get(&relative)
                    .filter(|(stamp, _)| stamp == &identity)
                    .map(|(_, hash)| hash.clone());
                let hash = if let Some(hash) = cached {
                    hash
                } else {
                    let hash = file_digest(&mut file)?;
                    let mut cache = self.read_cache.lock().unwrap();
                    if cache.len() >= 128 {
                        cache.clear();
                    }
                    cache.insert(relative.clone(), (identity, hash.clone()));
                    hash
                };
                if request["expected_sha256"]
                    .as_str()
                    .is_some_and(|v| v != hash)
                {
                    bail!("REMOTE_FILE_CHANGED");
                }
                let offset = request["offset"].as_u64().unwrap_or(0);
                if offset > len {
                    bail!("INVALID_OFFSET");
                }
                file.seek(SeekFrom::Start(offset))?;
                let mut bytes = vec![0; (len - offset).min(CHUNK as u64) as usize];
                file.read_exact(&mut bytes)?;
                Ok(
                    json!({"sha256":hash,"size":len,"offset":offset,"bytes":encode(&bytes),"eof":offset+bytes.len() as u64==len}),
                )
            }
            _ => bail!("INVALID_HOST_OPERATION"),
        }
    }
}
