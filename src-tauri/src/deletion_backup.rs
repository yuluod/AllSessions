use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata},
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

use jiff::Timestamp;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use walkdir::WalkDir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub const KEEP_LATEST: usize = 10;
pub const MIN_KEEP_LATEST: usize = 1;
pub const MAX_KEEP_LATEST: usize = 100;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

pub fn storage_info() -> Value {
    let root = match backup_root() {
        Ok(root) => root,
        Err(error) => return json!({ "enabled": false, "error": error }),
    };
    let backups = match valid_backups(&root) {
        Ok(backups) => backups,
        Err(error) => return json!({ "enabled": false, "error": error }),
    };
    let bytes = backups
        .iter()
        .fold(0_u64, |sum, backup| sum.saturating_add(backup.bytes));
    json!({
        "enabled": true,
        "path": root.to_string_lossy(),
        "count": backups.len(),
        "bytes": bytes,
        "keep_latest": KEEP_LATEST,
        "backups": backups.iter().map(BackupEntry::value).collect::<Vec<_>>(),
    })
}

pub fn delete(name: &str) -> Result<(), String> {
    let root = backup_root()?;
    delete_at(&root, name)
}

pub fn cleanup(keep: usize, expected: Option<&[String]>) -> Result<(), String> {
    if !(MIN_KEEP_LATEST..=MAX_KEEP_LATEST).contains(&keep) {
        return Err(format!(
            "备份保留数量必须在 {MIN_KEEP_LATEST} 到 {MAX_KEEP_LATEST} 之间"
        ));
    }
    cleanup_at(&backup_root()?, keep, expected)
}

pub fn create(
    operation: &str,
    source_kind: &str,
    session_id: &str,
    paths: &[PathBuf],
) -> Result<Value, String> {
    let root = backup_root()?;
    create_at(&root, operation, source_kind, session_id, paths)
}

fn backup_root() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or_else(|| "无法确定永久删除备份目录".to_string())?;
    backup_root_under(&base)
}

fn backup_root_under(base: &Path) -> Result<PathBuf, String> {
    let mut root = base.to_path_buf();
    for component in ["AllSessions", "backups", "deletions"] {
        root.push(component);
        check_backup_root(&root)?;
    }
    Ok(root)
}

pub(crate) fn create_at(
    root: &Path,
    operation: &str,
    source_kind: &str,
    session_id: &str,
    paths: &[PathBuf],
) -> Result<Value, String> {
    let targets = paths
        .iter()
        .filter(|path| path.exists())
        .cloned()
        .collect::<BTreeSet<_>>();
    if targets.is_empty() {
        return Err("没有找到可备份的原始数据；永久删除已取消".into());
    }
    check_backup_root(root)?;
    fs::create_dir_all(root)
        .map_err(|error| format!("无法创建删除备份目录（{}）：{error}", root.display()))?;
    lock_down_directory(root)?;
    let name = format!(
        "{}-{}",
        Timestamp::now().strftime("%Y%m%dT%H%M%SZ"),
        Uuid::new_v4()
    );
    let backup_dir = root.join(name);
    let staging_dir = root.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<Value, String> {
        let resources = staging_dir.join("resources");
        fs::create_dir_all(&resources).map_err(error_text)?;
        lock_down_directory(&staging_dir)?;
        lock_down_directory(&resources)?;

        let mut manifest_targets = Vec::new();
        let mut copied_files = 0_usize;
        for (index, source) in targets.iter().enumerate() {
            let file_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("data");
            let relative = PathBuf::from("resources").join(format!("{index:02}-{file_name}"));
            let destination = staging_dir.join(&relative);
            copied_files += copy_target(source, &destination)?;
            manifest_targets.push(json!({
                "original": source.to_string_lossy(),
                "backup": relative.to_string_lossy(),
            }));
        }
        let created_at = Timestamp::now()
            .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let manifest = json!({
            "version": 1,
            "created_at": created_at,
            "operation": operation,
            "source_kind": source_kind,
            "session_id": session_id,
            "targets": manifest_targets,
        });
        let manifest_path = staging_dir.join("manifest.json");
        fs::write(
            &manifest_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).map_err(error_text)?
            ),
        )
        .map_err(error_text)?;
        lock_down_file(&manifest_path)?;
        fs::rename(&staging_dir, &backup_dir).map_err(error_text)?;
        Ok(json!({
            "path": backup_dir.to_string_lossy(),
            "copied_files": copied_files,
            "created_at": created_at,
        }))
    })();
    if result.is_err()
        && staging_dir.exists()
        && let Err(error) = fs::remove_dir_all(&staging_dir)
    {
        eprintln!(
            "清理未完成的删除备份失败（{}）：{error}",
            staging_dir.display()
        );
    }
    result
}

struct BackupEntry {
    name: String,
    created_at: Timestamp,
    bytes: u64,
}

#[derive(Deserialize)]
struct BackupManifest {
    version: u32,
    created_at: String,
    targets: Vec<BackupTarget>,
}

#[derive(Deserialize)]
struct BackupTarget {
    original: String,
    backup: String,
}

impl BackupEntry {
    fn value(&self) -> Value {
        json!({
            "name": self.name,
            "created_at": self.created_at.to_string(),
            "bytes": self.bytes,
        })
    }
}

fn valid_backups(root: &Path) -> Result<Vec<BackupEntry>, String> {
    if !check_backup_root(root)? {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    for entry in fs::read_dir(root).map_err(error_text)? {
        let entry = entry.map_err(error_text)?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| is_backup_name(name)) else {
            continue;
        };
        if let Some(backup) = backup_entry(&entry.path(), name)? {
            backups.push(backup);
        }
    }
    backups.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.name.cmp(&left.name))
    });
    Ok(backups)
}

fn backup_entry(path: &Path, name: &str) -> Result<Option<BackupEntry>, String> {
    let Some(metadata) = metadata_if_exists(path)? else {
        return Ok(None);
    };
    if !metadata.is_dir() || is_link(&metadata) {
        return Ok(None);
    }
    let manifest_path = path.join("manifest.json");
    let Some(metadata) = metadata_if_exists(&manifest_path)? else {
        return Ok(None);
    };
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_MANIFEST_BYTES {
        return Ok(None);
    }
    let mut manifest = Vec::new();
    File::open(&manifest_path)
        .map_err(error_text)?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut manifest)
        .map_err(error_text)?;
    if manifest.len() as u64 > MAX_MANIFEST_BYTES {
        return Ok(None);
    }
    let Ok(manifest) = serde_json::from_slice::<BackupManifest>(&manifest) else {
        return Ok(None);
    };
    if manifest.version != 1
        || manifest.targets.is_empty()
        || manifest
            .targets
            .iter()
            .any(|target| target.original.is_empty() || target.backup.is_empty())
    {
        return Ok(None);
    }
    let Ok(created_at) = manifest.created_at.parse() else {
        return Ok(None);
    };
    let mut bytes = 0_u64;
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(error_text)?;
        let metadata = entry.metadata().map_err(error_text)?;
        if is_link(&metadata) || (!metadata.is_file() && !metadata.is_dir()) {
            return Ok(None);
        }
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok(Some(BackupEntry {
        name: name.to_string(),
        created_at,
        bytes,
    }))
}

fn delete_at(root: &Path, name: &str) -> Result<(), String> {
    if !is_backup_name(name) {
        return Err("备份名称无效".into());
    }
    check_backup_root(root)?;
    let target = root.join(name);
    if backup_entry(&target, name)?.is_none() {
        return Err("找不到有效的删除备份".into());
    }
    fs::remove_dir_all(&target).map_err(error_text)
}

fn cleanup_at(root: &Path, keep: usize, expected: Option<&[String]>) -> Result<(), String> {
    let backups = valid_backups(root)?;
    if let Some(expected) = expected
        && !backups
            .iter()
            .skip(keep)
            .map(|backup| &backup.name)
            .eq(expected)
    {
        return Err("备份列表已变化，请核对更新后的列表再清理".into());
    }
    for backup in backups.into_iter().skip(keep).rev() {
        delete_at(root, &backup.name)?;
    }
    Ok(())
}

fn metadata_if_exists(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error_text(error)),
    }
}

fn check_backup_root(root: &Path) -> Result<bool, String> {
    let Some(metadata) = metadata_if_exists(root)? else {
        return Ok(false);
    };
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("删除备份目录不是安全的本地目录".into());
    }
    Ok(true)
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn is_backup_name(name: &str) -> bool {
    let Some((time, uuid)) = name.split_at_checked(16) else {
        return false;
    };
    let Some(uuid) = uuid.strip_prefix('-') else {
        return false;
    };
    time.bytes().enumerate().all(|(index, byte)| match index {
        8 => byte == b'T',
        15 => byte == b'Z',
        _ => byte.is_ascii_digit(),
    }) && Uuid::parse_str(uuid).is_ok_and(|id| id.to_string() == uuid)
}

fn copy_target(source: &Path, destination: &Path) -> Result<usize, String> {
    let metadata = fs::symlink_metadata(source).map_err(error_text)?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "拒绝备份符号链接目标，永久删除已取消：{}",
            source.display()
        ));
    }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(error_text)?;
        }
        fs::copy(source, destination).map_err(error_text)?;
        return Ok(1);
    }
    if !metadata.is_dir() {
        return Err(format!("不支持备份该数据类型：{}", source.display()));
    }
    fs::create_dir_all(destination).map_err(error_text)?;
    let mut copied_files = 0_usize;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(error_text)?;
        let relative = entry.path().strip_prefix(source).map_err(error_text)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(format!(
                "备份目录包含符号链接，永久删除已取消：{}",
                entry.path().display()
            ));
        }
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(error_text)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(error_text)?;
            }
            fs::copy(entry.path(), &target).map_err(error_text)?;
            copied_files += 1;
        }
    }
    Ok(copied_files)
}

#[cfg(unix)]
fn lock_down_directory(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(error_text)
}

#[cfg(not(unix))]
fn lock_down_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn lock_down_file(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(error_text)
}

#[cfg(not(unix))]
fn lock_down_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tempfile::tempdir;

    use super::{cleanup, cleanup_at, create_at, delete_at, valid_backups};

    #[test]
    fn 永久删除备份会复制文件并记录清单() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("session.jsonl");
        std::fs::write(&source, "sensitive session").unwrap();
        let backup_root = directory.path().join("backups");

        let result = create_at(
            &backup_root,
            "delete_session",
            "codex",
            "session-1",
            std::slice::from_ref(&source),
        )
        .unwrap();

        let backup_dir = std::path::PathBuf::from(result["path"].as_str().unwrap());
        assert!(backup_dir.join("manifest.json").is_file());
        assert_eq!(result["copied_files"], 1);
        assert_eq!(
            std::fs::read_dir(backup_dir.join("resources"))
                .unwrap()
                .count(),
            1
        );
        assert_eq!(valid_backups(&backup_root).unwrap().len(), 1);
    }

    #[test]
    fn 备份统计包含占用空间并支持安全删除() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("session.jsonl");
        std::fs::write(&source, "sensitive session").unwrap();
        let backup_root = directory.path().join("backups");
        let result = create_at(
            &backup_root,
            "delete_session",
            "codex",
            "session-1",
            std::slice::from_ref(&source),
        )
        .unwrap();
        let name = std::path::Path::new(result["path"].as_str().unwrap())
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let entries = valid_backups(&backup_root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].bytes,
            std::fs::metadata(backup_root.join(name).join("manifest.json"))
                .unwrap()
                .len()
                + std::fs::metadata(&source).unwrap().len()
        );
        assert!(delete_at(&backup_root, name).is_ok());
        assert!(valid_backups(&backup_root).unwrap().is_empty());
        assert!(source.is_file());
    }

    #[test]
    fn 清理备份只保留最新条目并拒绝路径穿越() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("session.jsonl");
        std::fs::write(&source, "sensitive session").unwrap();
        let backup_root = directory.path().join("backups");
        for index in 0..3 {
            let result = create_at(
                &backup_root,
                "delete_session",
                "codex",
                &format!("session-{index}"),
                std::slice::from_ref(&source),
            )
            .unwrap();
            let backup_dir = std::path::PathBuf::from(result["path"].as_str().unwrap());
            let mut manifest = serde_json::from_str::<Value>(
                &std::fs::read_to_string(backup_dir.join("manifest.json")).unwrap(),
            )
            .unwrap();
            manifest["created_at"] = json!(format!("2020-01-0{}T00:00:00.000Z", index + 1));
            std::fs::write(
                backup_dir.join("manifest.json"),
                serde_json::to_string(&manifest).unwrap(),
            )
            .unwrap();
        }
        assert!(delete_at(&backup_root, "../backups").is_err());
        let newest = valid_backups(&backup_root).unwrap().remove(0).name;
        assert!(cleanup_at(&backup_root, 1, Some(&[])).is_err());
        assert_eq!(valid_backups(&backup_root).unwrap().len(), 3);
        let expected = valid_backups(&backup_root)
            .unwrap()
            .into_iter()
            .skip(1)
            .map(|backup| backup.name)
            .collect::<Vec<_>>();
        cleanup_at(&backup_root, 1, Some(&expected)).unwrap();
        let backups = valid_backups(&backup_root).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].name, newest);
    }

    #[test]
    fn 自定义保留数量限制在安全范围内() {
        assert!(cleanup(0, None).is_err());
        assert!(cleanup(101, None).is_err());
    }

    #[test]
    fn 备份统计忽略没有清单的目录() {
        let directory = tempdir().unwrap();
        let incomplete = directory.path().join(".incomplete.tmp");
        std::fs::create_dir_all(&incomplete).unwrap();
        std::fs::write(incomplete.join("copied-data"), "sensitive").unwrap();

        assert!(valid_backups(directory.path()).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn 清理拒绝重定向目录与清单并保留损坏备份() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let source = directory.path().join("original");
        std::fs::write(&source, "synthetic").unwrap();
        let root = directory.path().join("backups");
        let result = create_at(
            &root,
            "delete_session",
            "codex",
            "id",
            std::slice::from_ref(&source),
        )
        .unwrap();
        let path = std::path::PathBuf::from(result["path"].as_str().unwrap());
        let name = path.file_name().unwrap().to_str().unwrap();
        let manifest = path.join("manifest.json");
        let saved_manifest = directory.path().join("manifest.json");
        std::fs::rename(&manifest, &saved_manifest).unwrap();
        symlink(&saved_manifest, &manifest).unwrap();
        assert!(delete_at(&root, name).is_err());
        std::fs::remove_file(&manifest).unwrap();
        std::fs::write(&manifest, "{}").unwrap();
        cleanup_at(&root, 0, None).unwrap();
        assert!(path.is_dir());
        std::fs::copy(&saved_manifest, &manifest).unwrap();

        let root_link = directory.path().join("AllSessions");
        symlink(&root, &root_link).unwrap();
        assert!(super::backup_root_under(directory.path()).is_err());
        assert!(delete_at(&root_link, name).is_err());

        let entry_link = root.join("20200101T000000Z-00000000-0000-4000-8000-000000000000");
        symlink(&path, &entry_link).unwrap();
        assert!(delete_at(&root, entry_link.file_name().unwrap().to_str().unwrap()).is_err());
        symlink(&source, path.join("resources").join("linked")).unwrap();
        assert!(delete_at(&root, name).is_err());
        assert!(path.is_dir());
        assert_eq!(std::fs::read_to_string(source).unwrap(), "synthetic");
    }

    #[cfg(unix)]
    #[test]
    fn 备份失败会清理临时目录() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let source = directory.path().join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("a-data"), "sensitive").unwrap();
        symlink(source.join("a-data"), source.join("z-link")).unwrap();
        let backup_root = directory.path().join("backups");

        let result = create_at(
            &backup_root,
            "delete_session",
            "gemini",
            "session-1",
            &[source],
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(&backup_root).unwrap().count(), 0);
    }
}
