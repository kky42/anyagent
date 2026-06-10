import { deleteControlFile, readControlFile } from "./control-file.js";
import { toErrorMessage } from "../utils.js";

function isPidAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return false;
  }
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

async function postJson(url, token, payload) {
  const response = await fetch(`${url}/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  return body ?? {
    ok: false,
    text: `Control endpoint returned HTTP ${response.status}.`
  };
}

export async function sendControlCommand(configPath, payload) {
  const info = await readControlFile(configPath);
  if (!info?.url || !info?.token) {
    throw new Error(`AnyAgent relay is not running for config ${configPath}.`);
  }

  try {
    return await postJson(info.url, info.token, payload);
  } catch (error) {
    if (!isPidAlive(info.pid)) {
      await deleteControlFile(configPath);
      throw new Error(`AnyAgent relay is not running for config ${configPath}.`);
    }
    throw new Error(
      `AnyAgent relay control endpoint is unreachable for config ${configPath}: ${toErrorMessage(error)}`
    );
  }
}
