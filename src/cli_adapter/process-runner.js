import { spawn } from "node:child_process";

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
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
  const child = spawn(command, args, {
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
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!hasChildExited(child)) {
          child.kill("SIGKILL");
        }
      }, forceKillDelayMs).unref();
    }
  };
}
