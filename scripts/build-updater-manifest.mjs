import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredPlatforms = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "windows-x86_64",
];

function artifactArchitecture(name) {
  const normalized = name.toLowerCase();
  if (/(^|[_.-])(aarch64|arm64)([_.-]|$)/.test(normalized)) return "aarch64";
  if (/(^|[_.-])(x86_64|x64|amd64)([_.-]|$)/.test(normalized)) return "x86_64";
  return null;
}

export function updaterPlatformKeys(name) {
  const architecture = artifactArchitecture(name);
  if (!architecture) return [];

  if (name.endsWith(".app.tar.gz")) {
    return [`darwin-${architecture}`, `darwin-${architecture}-app`];
  }
  if (name.endsWith("-setup.exe")) {
    return [`windows-${architecture}`, `windows-${architecture}-nsis`];
  }
  if (name.endsWith(".deb")) {
    return [`linux-${architecture}`, `linux-${architecture}-deb`];
  }
  return [];
}

function publishedAssetUrl(asset, tagName) {
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    return asset.url;
  }
  const marker = "/releases/download/";
  const markerIndex = url.pathname.indexOf(marker);
  if (url.hostname !== "github.com" || markerIndex === -1) return asset.url;

  const repositoryPath = url.pathname.slice(0, markerIndex);
  url.pathname = `${repositoryPath}${marker}${encodeURIComponent(tagName)}/${encodeURIComponent(asset.name)}`;
  return url.toString();
}

export function buildUpdaterManifest({ metadata, signatures, version }) {
  if (metadata.tagName !== `v${version}`) {
    throw new Error(
      `发布标签 ${metadata.tagName} 与项目版本 v${version} 不一致`
    );
  }
  if (!metadata.publishedAt) throw new Error("发布信息缺少 publishedAt");

  const assetsByName = new Map(
    metadata.assets.map((asset) => [asset.name, asset])
  );
  const platforms = {};
  for (const signatureName of Object.keys(signatures).sort()) {
    const artifactName = signatureName.slice(0, -".sig".length);
    const asset = assetsByName.get(artifactName);
    if (!asset)
      throw new Error(
        `签名 ${signatureName} 找不到对应发布资源 ${artifactName}`
      );

    for (const platform of updaterPlatformKeys(artifactName)) {
      if (platforms[platform])
        throw new Error(`平台 ${platform} 匹配到多个更新资源`);
      platforms[platform] = {
        signature: signatures[signatureName].trim(),
        // 草稿 Release 的 asset.url 使用临时的 untagged-* 路径，发布后会失效。
        // 清单始终写入由正式 tag 和附件名组成的稳定 GitHub 下载地址。
        url: publishedAssetUrl(asset, metadata.tagName),
      };
    }
  }

  const missing = requiredPlatforms.filter((platform) => !platforms[platform]);
  if (missing.length > 0)
    throw new Error(`更新清单缺少平台：${missing.join(", ")}`);

  return {
    version,
    notes: metadata.body ?? "",
    pub_date: metadata.publishedAt,
    platforms,
  };
}

async function readSignatures(directory) {
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".sig")
  );
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(path.join(directory, name), "utf8"),
      ])
    )
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [metadataPath, signaturesPath, outputPath] = process.argv.slice(2);
  if (!metadataPath || !signaturesPath || !outputPath) {
    throw new Error(
      "用法：node scripts/build-updater-manifest.mjs <release-metadata.json> <signatures-dir> <output.json>"
    );
  }

  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const [metadata, signatures, packageJson] = await Promise.all([
    readFile(metadataPath, "utf8").then(JSON.parse),
    readSignatures(signaturesPath),
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  const manifest = buildUpdaterManifest({
    metadata,
    signatures,
    version: packageJson.version,
  });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`更新清单已生成：${outputPath}`);
}
