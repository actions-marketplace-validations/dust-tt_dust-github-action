import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import axios from "axios";
import axiosRetry, { exponentialDelay, isRetryableError } from "axios-retry";
import FormData from "form-data";
import { glob } from "glob";
import Config from "../config.js";

/**
 * Finds SKILL.md files, zips their parent directories, and uploads to Dust.
 * @param {Config} config
 */
export default async function upsertSkills(config) {
  const core = config.core;

  // Find all SKILL.md files (case-insensitive) from the repo root.
  const skillFiles = await glob("**/[sS][kK][iI][lL][lL].[mM][dD]", {
    nodir: true,
  });

  if (skillFiles.length === 0) {
    core.notice("No SKILL.md files found.");
    return;
  }

  core.info(`Found ${skillFiles.length} skill(s).`);

  // Collect unique skill directories.
  const skillDirs = [...new Set(skillFiles.map((f) => path.dirname(f)))];

  // Create ZIP containing each skill directory.
  const zip = new AdmZip();
  for (const dir of skillDirs) {
    const absDir = path.resolve(dir);
    addDirectoryToZip(zip, absDir, dir);
    core.info(`  Added ${dir}`);
  }

  const zipBuffer = zip.toBuffer();
  const maxSizeBytes = 5 * 1024 * 1024;
  if (zipBuffer.length > maxSizeBytes) {
    throw new Error(
      `ZIP is ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB, exceeding the 5 MB limit.`,
    );
  }

  // Upload to Dust API.
  const { apiUrl, workspaceId, apiKey } = config.inputs;
  const url = `${apiUrl}/api/v1/w/${workspaceId}/skills`;

  const form = new FormData();
  form.append("files", zipBuffer, {
    filename: "skills.zip",
    contentType: "application/zip",
  });

  const client = axios.create();
  axiosRetry(client, {
    retries: 3,
    retryCondition: isRetryableError,
    retryDelay: (count, err) => exponentialDelay(count, err, 1000),
    onRetry: (count) => core.info(`Retrying request (attempt ${count})...`),
  });

  const response = await client.post(url, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${apiKey}`,
    },
    maxBodyLength: maxSizeBytes,
  });

  const data = response.data;

  core.setOutput("json", JSON.stringify(data));
  core.setOutput("imported", data.imported?.length ?? 0);
  core.setOutput("updated", data.updated?.length ?? 0);

  const importedCount = data.imported?.length ?? 0;
  const updatedCount = data.updated?.length ?? 0;
  const erroredCount = data.errored?.length ?? 0;

  core.notice(
    `Synced skills — imported: ${importedCount}, updated: ${updatedCount}, errored: ${erroredCount}`,
  );

  for (const skill of data.imported ?? []) {
    core.info(`  + ${skill.name}`);
  }
  for (const skill of data.updated ?? []) {
    core.info(`  ~ ${skill.name}`);
  }
  for (const err of data.errored ?? []) {
    core.warning(`Skill ${err.name}: ${err.message}`);
  }
}

/**
 * Recursively adds a directory's contents to an AdmZip instance.
 * @param {AdmZip} zip
 * @param {string} absDir - Absolute path to the directory on disk.
 * @param {string} zipDir - Relative path inside the ZIP.
 */
function addDirectoryToZip(zip, absDir, zipDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    const zipPath = path.join(zipDir, entry.name);
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, absPath, zipPath);
    } else {
      zip.addFile(zipPath, fs.readFileSync(absPath));
    }
  }
}
