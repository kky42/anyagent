import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_PORT = 18065;
const DEFAULT_CONTAINER = "anyagent-mattermost-e2e";
const DEFAULT_IMAGE = "mattermost/mattermost-preview:latest";
const DEFAULT_DOCKER_PLATFORM = "linux/amd64";

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function envValue(name, defaultValue) {
  const value = process.env[name];
  return value === undefined || value === "" ? defaultValue : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, maxLength = 6000) {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^a-z0-9]/g, "")
    .slice(-10);
}

function normalizeServerUrl(rawUrl) {
  return String(rawUrl ?? "").trim().replace(/\/+$/, "");
}

function cronInMinutes(minutesFromNow) {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  return [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    "*"
  ].join(" ");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });

  if (result.error && !options.ignoreFailure) {
    throw result.error;
  }
  if (result.status !== 0 && !options.ignoreFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.status}\nstdout:\n${tail(result.stdout ?? "")}\nstderr:\n${tail(result.stderr ?? "")}`
    );
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function docker(args, options = {}) {
  return runCommand("docker", args, options);
}

async function waitFor(predicate, { label, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 500 }) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await predicate();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${label} timed out after ${timeoutMs}ms.${suffix}`);
}

async function waitForMattermostReady(serverUrl, timeoutMs) {
  await waitFor(
    async () => {
      const response = await fetch(`${serverUrl}/api/v4/system/ping`);
      if (!response.ok) {
        return false;
      }
      const body = await response.json().catch(() => null);
      return body?.status === "OK";
    },
    {
      label: `Mattermost ${serverUrl} to become ready`,
      timeoutMs,
      intervalMs: 1000
    }
  );
}

async function mattermostRequest(serverUrl, method, apiPath, { token = null, body = undefined } = {}) {
  const normalizedPath = String(apiPath ?? "").startsWith("/") ? apiPath : `/${apiPath}`;
  const headers = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  let requestBody;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${serverUrl}/api/v4${normalizedPath}`, {
    method,
    headers,
    body: requestBody
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text ? { message: text } : null;
  }

  if (!response.ok) {
    throw new Error(
      `Mattermost ${method} ${normalizedPath} failed with ${response.status}: ${parsed?.message ?? text}`
    );
  }

  return {
    body: parsed,
    headers: response.headers,
    status: response.status
  };
}

function tokenFromLogin(response, username) {
  const token = response.headers.get("token");
  if (!token) {
    throw new Error(`Mattermost login for ${username} did not return a token header.`);
  }
  return token;
}

async function createMattermostFixture(serverUrl) {
  const suffix = uniqueSuffix();
  const adminUsername = `aaadmin${suffix}`;
  const botUsername = `aabot${suffix}`;
  const password = `Password1!${suffix}`;

  const adminUser = {
    email: `${adminUsername}@example.test`,
    username: adminUsername,
    password
  };
  const botUser = {
    email: `${botUsername}@example.test`,
    username: botUsername,
    password
  };

  const adminCreate = await mattermostRequest(serverUrl, "POST", "/users", { body: adminUser });
  const adminLogin = await mattermostRequest(serverUrl, "POST", "/users/login", {
    body: {
      login_id: adminUsername,
      password
    }
  });
  const adminToken = tokenFromLogin(adminLogin, adminUsername);

  const botCreate = await mattermostRequest(serverUrl, "POST", "/users", {
    token: adminToken,
    body: botUser
  });
  const botLogin = await mattermostRequest(serverUrl, "POST", "/users/login", {
    body: {
      login_id: botUsername,
      password
    }
  });
  const botToken = tokenFromLogin(botLogin, botUsername);

  const team = await mattermostRequest(serverUrl, "POST", "/teams", {
    token: adminToken,
    body: {
      name: `anyagent-e2e-${suffix}`,
      display_name: "AnyAgent E2E",
      type: "O"
    }
  });
  for (const userId of [adminCreate.body.id, botCreate.body.id]) {
    await mattermostRequest(serverUrl, "POST", `/teams/${team.body.id}/members`, {
      token: adminToken,
      body: {
        team_id: team.body.id,
        user_id: userId
      }
    });
  }

  const channel = await mattermostRequest(serverUrl, "POST", "/channels", {
    token: adminToken,
    body: {
      team_id: team.body.id,
      name: `relay-e2e-${suffix}`,
      display_name: "Relay E2E",
      type: "O"
    }
  });
  for (const userId of [adminCreate.body.id, botCreate.body.id]) {
    await mattermostRequest(serverUrl, "POST", `/channels/${channel.body.id}/members`, {
      token: adminToken,
      body: {
        user_id: userId
      }
    });
  }

  const direct = await mattermostRequest(serverUrl, "POST", "/channels/direct", {
    token: adminToken,
    body: [adminCreate.body.id, botCreate.body.id]
  });

  return {
    suffix,
    adminUsername,
    adminToken,
    adminUserId: adminCreate.body.id,
    botUsername,
    botToken,
    botUserId: botCreate.body.id,
    teamId: team.body.id,
    channelId: channel.body.id,
    directChannelId: direct.body.id
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeFakeCodex(fakeBinDir, logPath) {
  await fs.mkdir(fakeBinDir, { recursive: true });
  const fakeSource = `import fs from "node:fs";

const logPath = process.env.FAKE_CODEX_LOG_PATH;
const args = process.argv.slice(2);

function parseConfigValue(key) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c") {
      continue;
    }
    const raw = String(args[index + 1] ?? "");
    const prefix = key + "=";
    if (!raw.startsWith(prefix)) {
      continue;
    }
    try {
      return JSON.parse(raw.slice(prefix.length));
    } catch {
      return raw.slice(prefix.length);
    }
  }
  return "";
}

function append(entry) {
  if (!logPath) {
    return;
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n", "utf8");
}

function responseForPrompt(prompt) {
  if (/private ping/i.test(prompt)) {
    return "Private pong from local Mattermost.";
  }
  if (/private file request/i.test(prompt)) {
    return "Private file follows.\\nATTACH ./artifacts/private.txt";
  }
  if (/unrelated group chatter/i.test(prompt)) {
    return "NO_REPLY";
  }
  if (/answer channel with file/i.test(prompt)) {
    return [
      "private scratch text",
      "REPLY",
      "Group visible response from local Mattermost.",
      "ATTACH ./artifacts/group.txt"
    ].join("\\n");
  }
  return "Fallback fake Codex response.";
}

const prompt = args.at(-1) ?? "";
const developerInstructions = parseConfigValue("developer_instructions");
const text = responseForPrompt(prompt);
append({ phase: "start", prompt, developerInstructions, argv: args });
process.stdout.write(JSON.stringify({
  type: "thread.started",
  thread_id: "mattermost-local-e2e-session"
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text
  }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
append({ phase: "done", prompt, developerInstructions, text });
`;

  const fakeModulePath = path.join(fakeBinDir, "codex.mjs");
  await fs.writeFile(fakeModulePath, fakeSource, "utf8");

  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(fakeBinDir, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0\\codex.mjs" %*\r\n`,
      "utf8"
    );
    return;
  }

  const shimPath = path.join(fakeBinDir, "codex");
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env sh\nexec "${process.execPath}" "${fakeModulePath}" "$@"\n`,
    "utf8"
  );
  await fs.chmod(shimPath, 0o755);
}

async function readFakeCodexLog(logPath) {
  let content = "";
  try {
    content = await fs.readFile(logPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForFakeInvocation(logPath, predicate, label, timeoutMs) {
  return waitFor(
    async () => {
      const entries = await readFakeCodexLog(logPath);
      return entries.find((entry) => entry.phase === "done" && predicate(entry));
    },
    { label, timeoutMs, intervalMs: 250 }
  );
}

function assertPrivateOutputContract(entry) {
  assert.match(entry.developerInstructions, /ATTACH \.\/artifacts\/chart\.png/);
  assert.doesNotMatch(entry.developerInstructions, /NO_REPLY/);
  assert.doesNotMatch(entry.developerInstructions, /REPLY/);
}

function assertResumedWithoutDeveloperInstructions(entry) {
  assert.equal(entry.developerInstructions, "");
}

function assertGroupOutputContract(entry) {
  assert.match(entry.prompt, /^Messages since your last turn:/);
  assert.match(entry.developerInstructions, /## Situation/);
  assert.match(entry.developerInstructions, /in a group chat/);
  assert.match(entry.developerInstructions, /## Output Contract/);
  assert.match(entry.developerInstructions, /## Group Chat Rules/);
  assert.match(entry.developerInstructions, /NO_REPLY/);
  assert.match(entry.developerInstructions, /REPLY/);
  assert.match(entry.developerInstructions, /Absolute paths are allowed and must stay absolute/);
  assert.match(entry.developerInstructions, /Only content inside REPLY blocks is sent to the group/);
}

function startRelay({ configRoot, fakeBinDir, fakeCodexLogPath }) {
  const state = {
    stdout: "",
    stderr: "",
    exit: null
  };
  const relay = spawn(process.execPath, [path.resolve("bin/anyagent.js"), "--config", configRoot], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_CODEX_LOG_PATH: fakeCodexLogPath,
      FORCE_COLOR: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  relay.stdout.setEncoding("utf8");
  relay.stderr.setEncoding("utf8");
  relay.stdout.on("data", (chunk) => {
    state.stdout = tail(state.stdout + chunk, 20_000);
  });
  relay.stderr.on("data", (chunk) => {
    state.stderr = tail(state.stderr + chunk, 20_000);
  });
  relay.once("exit", (code, signal) => {
    state.exit = { code, signal };
  });

  return { relay, state };
}

async function waitForRelayLog(state, pattern, label, timeoutMs) {
  await waitFor(
    () => {
      if (state.exit) {
        throw new Error(
          `AnyAgent exited before ${label}: code=${state.exit.code} signal=${state.exit.signal}\nstderr:\n${tail(state.stderr)}`
        );
      }
      return pattern.test(state.stderr);
    },
    { label, timeoutMs, intervalMs: 250 }
  );
}

async function stopRelay(relay) {
  if (!relay || relay.exitCode !== null || relay.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      relay.kill("SIGKILL");
      resolve();
    }, 5000);
    relay.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    relay.kill("SIGTERM");
  });
}

async function createConfig({ configRoot, fixture, serverUrl, workdir }) {
  await writeJson(path.join(configRoot, "main", "config.json"), {
    profile: {
      cli: "codex",
      workdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    bindings: {
      telegram: {
        allowedUsernames: [],
        bots: []
      },
      mattermost: {
        allowedUsernames: [fixture.adminUsername],
        bots: [
          {
            serverUrl,
            username: fixture.botUsername,
            token: fixture.botToken,
            allowedUsernames: [fixture.adminUsername]
          }
        ]
      }
    }
  });
}

async function createPost(serverUrl, token, channelId, message) {
  return mattermostRequest(serverUrl, "POST", "/posts", {
    token,
    body: {
      channel_id: channelId,
      message
    }
  });
}

async function channelPosts(serverUrl, token, channelId) {
  const result = await mattermostRequest(
    serverUrl,
    "GET",
    `/channels/${channelId}/posts?page=0&per_page=100`,
    { token }
  );
  const order = Array.isArray(result.body?.order) ? result.body.order : [];
  const posts = result.body?.posts && typeof result.body.posts === "object" ? result.body.posts : {};
  return order.map((postId) => posts[postId]).filter(Boolean);
}

async function botPostsSince(serverUrl, token, channelId, botUserId, sinceMs) {
  const posts = await channelPosts(serverUrl, token, channelId);
  return posts.filter(
    (post) =>
      String(post?.user_id ?? "") === botUserId &&
      Number(post?.create_at ?? 0) >= sinceMs
  );
}

async function botPostIds(serverUrl, token, channelId, botUserId) {
  const posts = await channelPosts(serverUrl, token, channelId);
  return new Set(
    posts
      .filter((post) => String(post?.user_id ?? "") === botUserId)
      .map((post) => String(post.id))
  );
}

async function waitForBotPost(serverUrl, token, channelId, botUserId, sinceMs, predicate, label, timeoutMs) {
  return waitFor(
    async () => {
      const posts = await botPostsSince(serverUrl, token, channelId, botUserId, sinceMs);
      return posts.find(predicate);
    },
    { label, timeoutMs, intervalMs: 500 }
  );
}

async function main() {
  const timeoutMs = Number(envValue("MATTERMOST_E2E_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
  const hostPort = Number(envValue("MATTERMOST_E2E_PORT", DEFAULT_PORT));
  const containerName = envValue("MATTERMOST_E2E_CONTAINER", DEFAULT_CONTAINER);
  const image = envValue("MATTERMOST_E2E_IMAGE", DEFAULT_IMAGE);
  const dockerPlatform = envValue("MATTERMOST_E2E_DOCKER_PLATFORM", DEFAULT_DOCKER_PLATFORM);
  const keepServer = boolEnv("MATTERMOST_E2E_KEEP_SERVER", false);
  const keepTemp = boolEnv("MATTERMOST_E2E_KEEP_TEMP", false);
  const restartServer = boolEnv("MATTERMOST_E2E_RESTART_SERVER", true);
  const serverUrl = normalizeServerUrl(envValue("MATTERMOST_E2E_SERVER_URL", `http://localhost:${hostPort}`));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-mm-local-e2e-"));
  const configRoot = path.join(tempDir, "agents");
  const fakeBinDir = path.join(tempDir, "bin");
  const fakeCodexLogPath = path.join(tempDir, "fake-codex.jsonl");
  const workdir = path.join(tempDir, "workspace");
  const artifactDir = path.join(workdir, "artifacts");
  let relay = null;

  try {
    if (!process.env.MATTERMOST_E2E_SERVER_URL) {
      console.log(`[mattermost-e2e] starting local Mattermost ${image} on ${serverUrl}`);
      docker(["rm", "-f", containerName], { ignoreFailure: true });
      const platformArgs =
        dockerPlatform && dockerPlatform !== "native" ? ["--platform", dockerPlatform] : [];
      docker([
        "run",
        "-d",
        ...platformArgs,
        "--name",
        containerName,
        "-p",
        `${hostPort}:8065`,
        image
      ]);
    } else {
      console.log(`[mattermost-e2e] using existing Mattermost at ${serverUrl}`);
    }

    await waitForMattermostReady(serverUrl, timeoutMs);
    const fixture = await createMattermostFixture(serverUrl);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "private.txt"), "private artifact", "utf8");
    await fs.writeFile(path.join(artifactDir, "group.txt"), "group artifact", "utf8");
    await writeFakeCodex(fakeBinDir, fakeCodexLogPath);
    await createConfig({ configRoot, fixture, serverUrl, workdir });

    const relayState = startRelay({ configRoot, fakeBinDir, fakeCodexLogPath });
    relay = relayState.relay;
    await waitForRelayLog(
      relayState.state,
      /websocket reconnect success: count=1/,
      "AnyAgent Mattermost websocket connection",
      timeoutMs
    );

    console.log("[mattermost-e2e] testing direct message text response");
    let sinceMs = Date.now() - 1000;
    await createPost(serverUrl, fixture.adminToken, fixture.directChannelId, "private ping");
    const privatePing = await waitForFakeInvocation(
      fakeCodexLogPath,
      (entry) => /private ping/.test(entry.prompt),
      "fake Codex private ping invocation",
      timeoutMs
    );
    assertPrivateOutputContract(privatePing);
    await waitForBotPost(
      serverUrl,
      fixture.adminToken,
      fixture.directChannelId,
      fixture.botUserId,
      sinceMs,
      (post) => /Private pong from local Mattermost\./.test(post.message ?? ""),
      "direct message bot response",
      timeoutMs
    );

    console.log("[mattermost-e2e] testing direct message file response");
    sinceMs = Date.now() - 1000;
    await createPost(serverUrl, fixture.adminToken, fixture.directChannelId, "private file request");
    const privateFile = await waitForFakeInvocation(
      fakeCodexLogPath,
      (entry) => /private file request/.test(entry.prompt),
      "fake Codex private file invocation",
      timeoutMs
    );
    assertResumedWithoutDeveloperInstructions(privateFile);
    await waitForBotPost(
      serverUrl,
      fixture.adminToken,
      fixture.directChannelId,
      fixture.botUserId,
      sinceMs,
      (post) => /Private file follows\./.test(post.message ?? ""),
      "direct file text bot response",
      timeoutMs
    );
    await waitForBotPost(
      serverUrl,
      fixture.adminToken,
      fixture.directChannelId,
      fixture.botUserId,
      sinceMs,
      (post) => Array.isArray(post.file_ids) && post.file_ids.length > 0,
      "direct file attachment bot response",
      timeoutMs
    );

    if (restartServer && !process.env.MATTERMOST_E2E_SERVER_URL) {
      console.log("[mattermost-e2e] restarting Mattermost to verify websocket reconnect");
      docker(["restart", containerName]);
      await waitForMattermostReady(serverUrl, timeoutMs);
      await waitForRelayLog(
        relayState.state,
        /websocket reconnect success: count=2/,
        "AnyAgent Mattermost websocket reconnect",
        timeoutMs
      );
    }

    console.log("[mattermost-e2e] testing addressed group schedule commands");
    const scheduleCron = cronInMinutes(10);
    const scheduleCases = [
      {
        name: "leading",
        scheduleName: `e2e-leading-${fixture.suffix}`,
        message: `@${fixture.botUsername} !schedule add heartbeat e2e-leading-${fixture.suffix}\n${scheduleCron}\ncontinue from leading mention`
      },
      {
        name: "first-argument",
        scheduleName: `e2e-argument-${fixture.suffix}`,
        message: `!schedule @${fixture.botUsername} add heartbeat e2e-argument-${fixture.suffix}\n${scheduleCron}\ncontinue from first argument mention`
      },
      {
        name: "command-token",
        scheduleName: `e2e-command-${fixture.suffix}`,
        message: `!schedule@${fixture.botUsername} add heartbeat e2e-command-${fixture.suffix}\n${scheduleCron}\ncontinue from command token mention`
      }
    ];
    for (const scheduleCase of scheduleCases) {
      sinceMs = Date.now() - 1000;
      await createPost(serverUrl, fixture.adminToken, fixture.channelId, scheduleCase.message);
      await waitForBotPost(
        serverUrl,
        fixture.adminToken,
        fixture.channelId,
        fixture.botUserId,
        sinceMs,
        (post) =>
          post.message ===
          `Added schedule "${scheduleCase.scheduleName}".\nmode: heartbeat\ncron: ${scheduleCron}`,
        `group schedule command ${scheduleCase.name}`,
        timeoutMs
      );
    }

    console.log("[mattermost-e2e] testing trailing group schedule target rejection");
    sinceMs = Date.now() - 1000;
    await createPost(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      `!schedule add heartbeat e2e-trailing-${fixture.suffix} @${fixture.botUsername}\n${scheduleCron}\nshould not create a schedule`
    );
    await waitForBotPost(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      fixture.botUserId,
      sinceMs,
      (post) => /Group commands must mention this bot/.test(post.message ?? ""),
      "trailing group schedule target rejection",
      timeoutMs
    );

    console.log("[mattermost-e2e] testing unrelated group output suppression");
    const botPostsBeforeUnrelated = await botPostIds(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      fixture.botUserId
    );
    await createPost(serverUrl, fixture.adminToken, fixture.channelId, "unrelated group chatter");
    const unrelatedInvocation = await waitForFakeInvocation(
      fakeCodexLogPath,
      (entry) => /unrelated group chatter/.test(entry.prompt),
      "fake Codex unrelated group invocation",
      timeoutMs
    );
    assertGroupOutputContract(unrelatedInvocation);
    await sleep(1500);
    const botPostsAfterUnrelated = await botPostsSince(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      fixture.botUserId,
      0
    );
    assert.deepEqual(
      botPostsAfterUnrelated.filter((post) => !botPostsBeforeUnrelated.has(String(post.id))),
      []
    );

    console.log("[mattermost-e2e] testing addressed group message and file response");
    sinceMs = Date.now() - 1000;
    await createPost(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      `@${fixture.botUsername} answer channel with file`
    );
    const groupInvocation = await waitForFakeInvocation(
      fakeCodexLogPath,
      (entry) => /answer channel with file/.test(entry.prompt),
      "fake Codex addressed group invocation",
      timeoutMs
    );
    assert.match(groupInvocation.prompt, /answer channel with file/);
    assertResumedWithoutDeveloperInstructions(groupInvocation);
    await waitForBotPost(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      fixture.botUserId,
      sinceMs,
      (post) => /Group visible response from local Mattermost\./.test(post.message ?? ""),
      "group visible bot response",
      timeoutMs
    );
    await waitForBotPost(
      serverUrl,
      fixture.adminToken,
      fixture.channelId,
      fixture.botUserId,
      sinceMs,
      (post) => Array.isArray(post.file_ids) && post.file_ids.length > 0,
      "group attachment bot response",
      timeoutMs
    );

    console.log("[mattermost-e2e] ok");
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await stopRelay(relay);
    if (!keepServer && !process.env.MATTERMOST_E2E_SERVER_URL) {
      docker(["rm", "-f", containerName], { ignoreFailure: true });
    } else {
      console.log(`[mattermost-e2e] kept Mattermost server/container: ${containerName}`);
    }
    if (!keepTemp) {
      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      console.log(`[mattermost-e2e] kept temp directory: ${tempDir}`);
    }
  }
}

main();
