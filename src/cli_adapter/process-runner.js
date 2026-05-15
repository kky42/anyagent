import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_NODE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

function getPathEnv(env) {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function getPathExts(env) {
  const raw = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

function hasPathSeparator(command) {
  return /[\\/]/.test(command);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function windowsCommandCandidates(basePath, env) {
  if (path.extname(basePath)) {
    return [basePath];
  }

  return getPathExts(env).map((ext) => `${basePath}${ext}`);
}

function resolveWindowsCommandPath(command, { cwd = process.cwd(), env = process.env } = {}) {
  const commandText = String(command);

  if (hasPathSeparator(commandText)) {
    const basePath = path.isAbsolute(commandText)
      ? commandText
      : path.resolve(cwd, commandText);
    return windowsCommandCandidates(basePath, env).find(isFile) ?? commandText;
  }

  const searchDirs = getPathEnv(env).split(path.delimiter).filter(Boolean);
  for (const dir of searchDirs) {
    const basePath = path.join(dir, commandText);
    const found = windowsCommandCandidates(basePath, env).find(isFile);
    if (found) {
      return found;
    }
  }

  return commandText;
}

function findNpmShimTarget(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const shimDir = path.dirname(shimPath);
  const patterns = [
    /"%dp0%[\\/]([^"]+)"/gi,
    /"%~dp0[\\/]([^"]+)"/gi
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const relativeTarget = match[1];
      if (!relativeTarget || /^node(?:\.exe)?$/i.test(relativeTarget)) {
        continue;
      }

      const targetPath = path.resolve(shimDir, relativeTarget.replace(/[\\/]/g, path.sep));
      if (isFile(targetPath)) {
        return targetPath;
      }
    }
  }

  return null;
}

function quoteWindowsBatchArg(value) {
  const text = String(value);
  if (text === "") {
    return "\"\"";
  }

  let quoted = "\"";
  let backslashes = 0;

  for (const char of text) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }

    if (char === "\"") {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += char;
      backslashes = 0;
      continue;
    }

    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += char;
  }

  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

function prepareWindowsBatchSpawn(command, args) {
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsBatchArg).join(" ")],
    options: {
      windowsHide: true,
      windowsVerbatimArguments: true
    }
  };
}

function prepareWindowsResolvedSpawn(resolvedCommand, args) {
  const extension = path.extname(resolvedCommand).toLowerCase();

  if (WINDOWS_BATCH_EXTENSIONS.has(extension)) {
    return prepareWindowsBatchSpawn(resolvedCommand, args);
  }

  if (WINDOWS_NODE_EXTENSIONS.has(extension)) {
    return {
      command: process.execPath,
      args: [resolvedCommand, ...args],
      options: { windowsHide: true }
    };
  }

  return {
    command: resolvedCommand,
    args,
    options: { windowsHide: true }
  };
}

export function prepareWindowsCliSpawn(command, args, options = {}) {
  const resolvedCommand = resolveWindowsCommandPath(command, {
    cwd: options.cwd,
    env: options.env
  });
  const extension = path.extname(resolvedCommand).toLowerCase();

  if (WINDOWS_BATCH_EXTENSIONS.has(extension)) {
    const targetPath = findNpmShimTarget(resolvedCommand);
    if (targetPath) {
      return prepareWindowsResolvedSpawn(targetPath, args);
    }

    return prepareWindowsBatchSpawn(resolvedCommand, args);
  }

  return prepareWindowsResolvedSpawn(resolvedCommand, args);
}

export function spawnCli(command, args, options = {}) {
  if (process.platform !== "win32") {
    return spawn(command, args, options);
  }

  const prepared = prepareWindowsCliSpawn(command, args, options);
  return spawn(prepared.command, prepared.args, {
    ...options,
    ...prepared.options
  });
}

export function spawnCliSync(command, args, options = {}) {
  if (process.platform !== "win32") {
    return spawnSync(command, args, options);
  }

  const prepared = prepareWindowsCliSpawn(command, args, options);
  return spawnSync(prepared.command, prepared.args, {
    ...options,
    ...prepared.options
  });
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function killWindowsProcessTree(child) {
  if (!child.pid) {
    child.kill();
    return;
  }

  const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true
  });
  killer.once("error", () => {
    child.kill();
  });
}

export function startCliJsonRun({
  command,
  args,
  cwd = process.cwd(),
  displayName = command,
  parseEventLine,
  isTerminalEvent,
  resolveNonZeroTerminalEvent = false,
  forceKillDelayMs = 3000,
  onEvent = async () => {},
  onStdErr = () => {}
}) {
  const child = spawnCli(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let pending = Promise.resolve();
  let aborted = false;
  let sawTerminalEvent = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const handleEvent = (event) => {
    if (!event) {
      return;
    }
    if (isTerminalEvent(event)) {
      sawTerminalEvent = true;
    }
    pending = pending.then(() => onEvent(event));
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      handleEvent(parseEventLine(line));
    }
  });

  child.stderr.on("data", (chunk) => {
    onStdErr(String(chunk));
  });

  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      if (stdoutBuffer.trim()) {
        handleEvent(parseEventLine(stdoutBuffer));
      }

      try {
        await pending;
      } catch (error) {
        reject(error);
        return;
      }

      if (aborted) {
        resolve({ code, signal, aborted: true, sawTerminalEvent });
        return;
      }

      if (code === 0 || (resolveNonZeroTerminalEvent && sawTerminalEvent)) {
        resolve({ code, signal, aborted: false, sawTerminalEvent });
        return;
      }

      reject(new Error(`${displayName} exited with code ${code}${signal ? ` (signal ${signal})` : ""}`));
    });
  });

  return {
    child,
    done,
    abort() {
      if (aborted || hasChildExited(child)) {
        return;
      }
      aborted = true;
      if (process.platform === "win32") {
        killWindowsProcessTree(child);
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!hasChildExited(child)) {
          child.kill("SIGKILL");
        }
      }, forceKillDelayMs).unref();
    }
  };
}
