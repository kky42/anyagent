import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { APP_DIR, ensureDir, readJsonFile } from "../utils.js";

const RUN_DIR = path.join(APP_DIR, "run");

export function canonicalConfigPath(configPath) {
  return path.resolve(configPath);
}

export function controlFilePath(configPath) {
  const resolved = canonicalConfigPath(configPath);
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return path.join(RUN_DIR, `${hash}.control.json`);
}

async function writePrivateJsonFileAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let handle = null;

  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeControlFile(configPath, info) {
  const filePath = controlFilePath(configPath);
  await writePrivateJsonFileAtomic(filePath, {
    ...info,
    configPath: canonicalConfigPath(configPath)
  });
  return filePath;
}

export async function readControlFile(configPath) {
  return readJsonFile(controlFilePath(configPath), null);
}

export async function deleteControlFile(configPath) {
  await fs.rm(controlFilePath(configPath), { force: true });
}
