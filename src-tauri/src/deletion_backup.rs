use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use uuid::Uuid;
use walkdir::WalkDir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub fn storage_info() -> Value {
    let Some(root) = backup_root() else {
        return json!({ "enabled": false });
    };
    let count = valid_backup_count(&root);
    json!({
        "enabled": true,
        "path": root.to_string_lossy(),
        "count": count,
    })
}

pub fn create(
    operation: &str,
    source_kind: &str,
    session_id: &str,
    paths: &[PathBuf],
) -> Result<Value, String> {
    let root = backup_root().ok_or_else(|| "无法确定永久删除备份目录".to_string())?;
    create_at(&root, operation, source_kind, session_id, paths)
}

fn backup_root() -> Option<PathBuf> {
    dirs::data_local_dir().map(|root| root.join("AllSessions").join("backups").join("deletions"))
}

fn create_at(
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
    fs::create_dir_all(root)
        .map_err(|error| format!("无法创建删除备份目录（{}）：{error}", root.display()))?;
    lock_down_directory(root)?;
    let name = format!("{}-{}", Utc::now().format("%Y%m%dT%H%M%SZ"), Uuid::new_v4());
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
        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
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
    if result.is_err() && staging_dir.exists() {
        if let Err(error) = fs::remove_dir_all(&staging_dir) {
            eprintln!(
                "清理未完成的删除备份失败（{}）：{error}",
                staging_dir.display()
            );
        }
    }
    result
}

fn valid_backup_count(root: &Path) -> usize {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().join("manifest.json").is_file())
                .count()
        })
        .unwrap_or_default()
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
    use tempfile::tempdir;

    use super::{create_at, valid_backup_count};

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
        assert_eq!(valid_backup_count(&backup_root), 1);
    }

    #[test]
    fn 备份统计忽略没有清单的目录() {
        let directory = tempdir().unwrap();
        let incomplete = directory.path().join(".incomplete.tmp");
        std::fs::create_dir_all(&incomplete).unwrap();
        std::fs::write(incomplete.join("copied-data"), "sensitive").unwrap();

        assert_eq!(valid_backup_count(directory.path()), 0);
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
