// src/index.ts
import * as core2 from "@actions/core";

// src/parsers.ts
import * as fs from "fs/promises";
import * as YAML from "yaml";
import * as TOML from "toml";
function parseFile(content, extension) {
  switch (extension.toLowerCase()) {
    case "json":
      return JSON.parse(content);
    case "yaml":
    case "yml":
      return YAML.parse(content);
    case "toml":
      return TOML.parse(content);
    default:
      throw new Error(`Unsupported file format: ${extension}`);
  }
}
async function extractVersion(filePath, queryPath) {
  const content = await fs.readFile(filePath, "utf-8");
  const extension = filePath.split(".").pop() || "json";
  const data = parseFile(content, extension);
  const keys = queryPath.split(".");
  let current = data;
  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      throw new Error(`Path "${queryPath}" not found in ${filePath}`);
    }
  }
  return String(current);
}

// src/git.ts
import { execSync } from "child_process";
import * as core from "@actions/core";
async function getPreviousFileContent(filePath) {
  try {
    const changedFiles = execSync("git diff --name-only HEAD~1..HEAD", {
      encoding: "utf-8"
    }).trim();
    if (!changedFiles.includes(filePath)) {
      core.info(`File ${filePath} was not changed in the last commit`);
      return null;
    }
    const previousContent = execSync(`git show HEAD~1:${filePath}`, {
      encoding: "utf-8"
    });
    return previousContent;
  } catch (error) {
    core.debug(`Could not get previous file content: ${error}`);
    return null;
  }
}

// src/version.ts
import * as semver from "semver";
function determineVersionChangeType(previousVersion, currentVersion) {
  const prev = semver.valid(previousVersion);
  const curr = semver.valid(currentVersion);
  if (prev && curr) {
    const diff2 = semver.diff(prev, curr);
    return diff2 || "unknown";
  }
  const prevParts = previousVersion.split(".");
  const currParts = currentVersion.split(".");
  for (let i = 0; i < Math.max(prevParts.length, currParts.length); i++) {
    const prevPart = parseInt(prevParts[i] || "0", 10);
    const currPart = parseInt(currParts[i] || "0", 10);
    if (currPart > prevPart) {
      if (i === 0) return "major";
      if (i === 1) return "minor";
      if (i === 2) return "patch";
    }
  }
  return "prerelease";
}

// src/index.ts
async function run() {
  try {
    const fileName = core2.getInput("file-name", { required: true });
    const diffSearch = core2.getInput("diff-search") === "true";
    core2.info(`Checking version in file: ${fileName}`);
    const [filePath, query] = fileName.includes("#") ? fileName.split("#") : [fileName, "version"];
    core2.info(`File path: ${filePath}`);
    core2.info(`Query path: ${query}`);
    const currentVersion = await extractVersion(filePath, query);
    core2.setOutput("version", currentVersion);
    core2.info(`Current version: ${currentVersion}`);
    if (diffSearch) {
      try {
        const previousContent = await getPreviousFileContent(filePath);
        if (previousContent) {
          const fileExtension = filePath.split(".").pop() || "json";
          const previousData = parseFile(previousContent, fileExtension);
          const previousVersion = getValueByPath(previousData, query);
          core2.setOutput("previous_version", previousVersion);
          core2.info(`Previous version: ${previousVersion}`);
          const changed = currentVersion !== previousVersion;
          core2.setOutput("changed", changed.toString());
          if (changed) {
            const changeType = determineVersionChangeType(previousVersion, currentVersion);
            core2.setOutput("type", changeType);
            core2.info(`Version changed: ${previousVersion} \u2192 ${currentVersion} (${changeType})`);
          } else {
            core2.info("Version unchanged");
          }
        } else {
          core2.setOutput("changed", "true");
          core2.info("No previous version found (possibly first commit)");
        }
      } catch (error) {
        core2.warning(`Could not get previous version: ${error}`);
        core2.setOutput("changed", "false");
      }
    } else {
      core2.setOutput("changed", "true");
    }
  } catch (error) {
    if (error instanceof Error) {
      core2.setFailed(error.message);
    } else {
      core2.setFailed("An unknown error occurred");
    }
  }
}
function getValueByPath(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      throw new Error(`Path "${path}" not found in object`);
    }
  }
  return String(current);
}
run();
