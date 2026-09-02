import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function extractReleaseNotes(changelog, tagName) {
  const version = String(tagName || "")
    .trim()
    .replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release tag: ${tagName}`);
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(
    `^## \\[${escapedVersion}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    "m"
  );
  const heading = headingPattern.exec(changelog);
  if (!heading) {
    throw new Error(`CHANGELOG.md does not contain version ${version}`);
  }

  const bodyStart = heading.index + heading[0].length;
  const remaining = changelog.slice(bodyStart);
  const nextHeading = /^## \[/m.exec(remaining);
  const notes = (
    nextHeading ? remaining.slice(0, nextHeading.index) : remaining
  ).trim();
  if (!notes) {
    throw new Error(`CHANGELOG.md version ${version} has no release notes`);
  }
  return notes + "\n";
}

async function main() {
  const [tagName, input = "CHANGELOG.md", output = "release-notes.md"] =
    process.argv.slice(2);
  if (!tagName) {
    throw new Error(
      "Usage: node scripts/extract-release-notes.mjs <tag> [input] [output]"
    );
  }
  const changelog = await readFile(path.resolve(input), "utf8");
  await writeFile(
    path.resolve(output),
    extractReleaseNotes(changelog, tagName),
    "utf8"
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error("Release notes extraction failed:", error.message);
    process.exitCode = 1;
  });
}
