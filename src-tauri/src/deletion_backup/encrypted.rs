use std::io::{self, BufReader, Write};

use age::{Decryptor, Encryptor, Identity, Recipient, scrypt};
use tar::{Builder, EntryType, Header};

use super::*;

pub(super) const ARCHIVE_NAME: &str = "backup.tar.age";
const AGE_MAGIC: &[u8] = b"age-encryption.org/v1\n";
// 固定工作因子让三平台生成的备份都能通过同一解密上限。
const SCRYPT_LOG_N: u8 = 17;

pub(super) fn write(
    directory: &Path,
    resources: &[(&PathBuf, String)],
    manifest: &str,
    passphrase: SecretString,
) -> Result<usize, String> {
    if manifest.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("删除备份清单过大".into());
    }
    let path = directory.join(ARCHIVE_NAME);
    let file = File::create_new(&path).map_err(error_text)?;
    lock_down_file(&path)?;
    let mut recipient = scrypt::Recipient::new(passphrase);
    recipient.set_work_factor(SCRYPT_LOG_N);
    let encryptor = Encryptor::with_recipients(std::iter::once(&recipient as &dyn Recipient))
        .map_err(error_text)?;
    let output = encryptor.wrap_output(file).map_err(error_text)?;
    let mut archive = Builder::new(output);
    archive
        .append_data(
            &mut file_header(manifest.len() as u64),
            "manifest.json",
            manifest.as_bytes(),
        )
        .map_err(error_text)?;
    let mut files = 0;
    for (source, relative) in resources {
        let metadata = fs::symlink_metadata(source).map_err(error_text)?;
        if is_link(&metadata) {
            return Err("加密备份不支持符号链接或重解析点，永久删除已取消".into());
        }
        for entry in WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(error_text)?;
            let metadata = entry.metadata().map_err(error_text)?;
            if is_link(&metadata) {
                return Err("加密备份不支持符号链接或重解析点，永久删除已取消".into());
            }
            let path = if entry.depth() == 0 {
                PathBuf::from(relative)
            } else {
                Path::new(relative).join(entry.path().strip_prefix(source).map_err(error_text)?)
            };
            if metadata.is_dir() {
                let mut header = file_header(0);
                header.set_entry_type(EntryType::Directory);
                header.set_mode(0o700);
                archive
                    .append_data(&mut header, path, io::empty())
                    .map_err(error_text)?;
            } else if metadata.is_file() {
                let mut source = File::open(entry.path()).map_err(error_text)?;
                let size = metadata.len();
                let mut reader = (&mut source).take(size);
                archive
                    .append_data(&mut file_header(size), path, &mut reader)
                    .map_err(error_text)?;
                if reader.limit() != 0 || source.read(&mut [0]).map_err(error_text)? != 0 {
                    return Err("原始文件在备份过程中发生变化，永久删除已取消".into());
                }
                files += 1;
            } else {
                return Err("加密备份包含不支持的文件类型，永久删除已取消".into());
            }
        }
    }
    archive
        .into_inner()
        .map_err(error_text)?
        .finish()
        .map_err(error_text)?
        .sync_all()
        .map_err(error_text)?;
    Ok(files)
}

fn file_header(size: u64) -> Header {
    let mut header = Header::new_gnu();
    header.set_mode(0o600);
    header.set_size(size);
    header
}

pub(super) fn entry(
    path: &Path,
    name: &str,
    metadata: &Metadata,
) -> Result<Option<BackupEntry>, String> {
    if !metadata.is_file() || is_link(metadata) || metadata.len() <= AGE_MAGIC.len() as u64 {
        return Ok(None);
    }
    let mut contents = fs::read_dir(path).map_err(error_text)?;
    contents.next().transpose().map_err(error_text)?;
    if contents.next().transpose().map_err(error_text)?.is_some() {
        return Ok(None);
    }
    let mut magic = [0; AGE_MAGIC.len()];
    File::open(path.join(ARCHIVE_NAME))
        .map_err(error_text)?
        .read_exact(&mut magic)
        .map_err(error_text)?;
    if magic != AGE_MAGIC {
        return Ok(None);
    }
    let Ok(created_at) = jiff::civil::DateTime::strptime("%Y%m%dT%H%M%SZ", &name[..16])
        .and_then(|time| time.to_zoned(jiff::tz::TimeZone::UTC))
    else {
        return Ok(None);
    };
    Ok(Some(BackupEntry {
        name: name.to_string(),
        created_at: created_at.timestamp(),
        bytes: metadata.len(),
        encrypted: true,
    }))
}

pub(super) fn decrypt_at(
    root: &Path,
    name: &str,
    directory: &Path,
    passphrase: SecretString,
) -> Result<PathBuf, String> {
    if !is_backup_name(name) || !check_backup_root(root)? {
        return Err("找不到加密的删除备份".into());
    }
    let backup = root.join(name);
    if !backup_entry(&backup, name)?.is_some_and(|entry| entry.encrypted) {
        return Err("找不到加密的删除备份".into());
    }
    if !directory.is_absolute() || !check_backup_root(directory)? {
        return Err("请选择一个本地目录保存解密归档".into());
    }
    let directory = directory.canonicalize().map_err(error_text)?;
    if directory.starts_with(root.canonicalize().map_err(error_text)?) {
        return Err("请选择删除备份目录以外的位置保存解密归档".into());
    }
    let output = directory.join(format!("{name}.tar"));
    if metadata_if_exists(&output)?.is_some() {
        return Err("目标目录已有同名归档，请选择其他位置".into());
    }
    let source = File::open(backup.join(ARCHIVE_NAME)).map_err(error_text)?;
    let decryptor = Decryptor::new_buffered(BufReader::new(source)).map_err(error_text)?;
    if !decryptor.is_scrypt() {
        return Err("这不是口令加密的删除备份".into());
    }
    let mut identity = scrypt::Identity::new(passphrase);
    identity.set_max_work_factor(SCRYPT_LOG_N);
    let mut decrypted = decryptor
        .decrypt(std::iter::once(&identity as &dyn Identity))
        .map_err(|_| "口令不正确或备份已损坏")?;
    let mut staging = tempfile::NamedTempFile::new_in(&directory).map_err(error_text)?;
    // 读取到 EOF 后 age 才验证完整归档，包括最后一个数据块。
    let mut buffer = [0; 8192];
    loop {
        let count = decrypted
            .read(&mut buffer)
            .map_err(|_| "备份读取失败或归档已损坏")?;
        if count == 0 {
            break;
        }
        staging.write_all(&buffer[..count]).map_err(error_text)?;
    }
    staging.as_file().sync_all().map_err(error_text)?;
    staging.persist_noclobber(&output).map_err(error_text)?;
    Ok(output)
}
