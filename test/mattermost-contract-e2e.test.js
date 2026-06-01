import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { BotRuntime } from "../src/chat_adapter/mattermost/bot-runtime.js";
import { flush, waitFor } from "./support/async.js";
import { createControlledRunnerFactory, FakeConfigStore } from "./support/fakes.js";

class FakeMattermostApi {
  constructor() {
    this.posts = [];
    this.updates = [];
    this.deletions = [];
    this.uploads = [];
    this.typing = [];
    this.channels = new Map();
    this.users = new Map();
    this.nextPostId = 1;
  }

  async getMe() {
    return { id: "bot-user", username: "relaybot", nickname: "Relay Bot" };
  }

  async getChannel(channelId) {
    return this.channels.get(channelId) ?? { id: channelId, type: "O" };
  }

  async getUser(userId) {
    return this.users.get(userId) ?? { id: userId, username: userId };
  }

  async getPost(postId) {
    return {
      id: postId,
      channel_id: "town-square",
      user_id: "u1",
      message: "thread root",
      create_at: 1000,
      file_ids: []
    };
  }

  async createPost(payload) {
    this.posts.push(payload);
    return { id: `post-${this.nextPostId++}` };
  }

  async updatePost(payload) {
    this.updates.push(payload);
    return { id: payload.postId };
  }

  async deletePost(payload) {
    this.deletions.push(payload);
    return { status: "OK" };
  }

  async uploadFile(payload) {
    this.uploads.push(payload);
    return { file_infos: [{ id: `file-${this.uploads.length}` }] };
  }

  async downloadFile(fileId) {
    return Buffer.from(`file:${fileId}`);
  }

  async getFileInfo(fileId) {
    return {
      id: fileId,
      name: `${fileId}.txt`,
      mime_type: "text/plain",
      size: 12
    };
  }
}

async function createRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-mm-contract-"));
  const workdir = path.join(tempDir, "workdir");
  const cacheRootDir = path.join(tempDir, "cache");
  await fs.mkdir(workdir, { recursive: true });

  const botApi = options.botApi ?? new FakeMattermostApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const botConfig = {
    platform: "mattermost",
    bindingId: "localhost:relaybot",
    serverUrl: "http://localhost:8065",
    username: "relaybot",
    token: "token",
    allowedUsernames: ["alice"],
    managerUsernames: ["alice"],
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    ...options.botConfig
  };
  const configStore = new FakeConfigStore({ loadedBotConfig: botConfig });
  const runtime = new BotRuntime({
    botConfig,
    botApi,
    configStore,
    createAgentRun: (params) => runnerFactory.createRun(params),
    cacheRootDir
  });
  await runtime.initialize();
  runtime.websocket = {
    sendTyping(payload) {
      botApi.typing.push(payload);
      return true;
    }
  };

  return { runtime, botApi, runnerFactory, tempDir, workdir };
}

function postedEvent(post) {
  return {
    event: "posted",
    data: {
      post: JSON.stringify(post)
    }
  };
}

async function sendPost(runtime, post) {
  await runtime.handleEvent(postedEvent(post));
  await flush();
}

async function finishRunWithAgentMessage(runtime, run, text) {
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text
    }
  });
  run.finish();
  await waitFor(() => {
    for (const session of runtime.sessions.values()) {
      if (session.isRunning) {
        return false;
      }
    }
    return true;
  });
}

async function finishRunAndKeepDraining(run, text) {
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text
    }
  });
  run.finish();
}

async function waitForRunCount(runnerFactory, count) {
  await waitFor(() => runnerFactory.runs.length === count, 20);
}

test("Mattermost direct E2E injects the private output contract and delivers text plus ATTACH files", async () => {
  const { runtime, botApi, runnerFactory, workdir } = await createRuntime();
  botApi.channels.set("dm1", { id: "dm1", type: "D" });
  botApi.users.set("u1", { id: "u1", username: "alice" });

  await sendPost(runtime, {
    id: "post1",
    channel_id: "dm1",
    user_id: "u1",
    message: "hello, can we talk first?",
    create_at: 1000,
    file_ids: []
  });
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "hello, can we talk first?");
  assert.equal(
    runnerFactory.runs[0].params.developerInstructions,
    PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
  );
  await finishRunWithAgentMessage(runtime, runnerFactory.runs[0], "Sure, I am here.");

  const artifactDir = path.join(workdir, "artifacts");
  const reportPath = path.join(artifactDir, "report.txt");
  const screenshotPath = path.join(artifactDir, "screenshot.png");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(reportPath, "private report", "utf8");
  await fs.writeFile(screenshotPath, "fake png", "utf8");

  await sendPost(runtime, {
    id: "post2",
    channel_id: "dm1",
    user_id: "u1",
    message: "now send a screenshot and a file to me",
    create_at: 2000,
    file_ids: []
  });
  assert.equal(runnerFactory.runs.length, 2);
  assert.equal(runnerFactory.runs[1].params.message, "now send a screenshot and a file to me");
  assert.equal(
    runnerFactory.runs[1].params.developerInstructions,
    PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
  );
  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[1],
    "Files follow.\nATTACH ./artifacts/screenshot.png\nATTACH ./artifacts/report.txt"
  );

  assert.equal(botApi.posts.length, 3);
  assert.equal(botApi.posts[0].channelId, "dm1");
  assert.equal(botApi.posts[1].channelId, "dm1");
  assert.doesNotMatch(botApi.posts[1].message, /ATTACH/);
  assert.deepEqual(botApi.posts.slice(2), [
    {
      channelId: "dm1",
      message: "",
      rootId: null,
      fileIds: ["file-1", "file-2"]
    }
  ]);
  assert.equal(botApi.uploads.length, 2);
  assert.deepEqual(
    botApi.uploads.map((upload) => ({
      channelId: upload.channelId,
      filePath: upload.filePath
    })),
    [
      { channelId: "dm1", filePath: screenshotPath },
      { channelId: "dm1", filePath: reportPath }
    ]
  );
});

test("Mattermost group E2E suppresses unrelated output with NO_REPLY", async () => {
  const { runtime, botApi, runnerFactory } = await createRuntime();
  botApi.channels.set("town-square", { id: "town-square", type: "O" });
  botApi.users.set("u1", { id: "u1", username: "alice" });

  await sendPost(runtime, {
    id: "post1",
    channel_id: "town-square",
    user_id: "u1",
    message: "I am just talking to the team, not the relay.",
    create_at: 1000,
    file_ids: []
  });

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /^Messages since your last turn:/);
  assert.match(
    runnerFactory.runs[0].params.message,
    /alice \(@alice\):\nI am just talking to the team, not the relay\./
  );
  assert.match(
    runnerFactory.runs[0].params.developerInstructions,
    /You are Relay Bot \(@relaybot\) in a group chat\./
  );
  assert.match(
    runnerFactory.runs[0].params.developerInstructions,
    /NO_REPLY/
  );

  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[0],
    "NO_REPLY"
  );

  assert.deepEqual(botApi.posts, []);
});

test("Mattermost group E2E sends related REPLY blocks and ATTACH files", async () => {
  const { runtime, botApi, runnerFactory, workdir } = await createRuntime();
  botApi.channels.set("town-square", { id: "town-square", type: "O" });
  botApi.users.set("u1", { id: "u1", username: "alice" });
  const artifactDir = path.join(workdir, "artifacts");
  const planPath = path.join(artifactDir, "plan.txt");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(planPath, "group plan", "utf8");

  await sendPost(runtime, {
    id: "post1",
    channel_id: "town-square",
    user_id: "u1",
    message: "@relaybot please answer the channel and attach the plan",
    create_at: 1000,
    file_ids: []
  });

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(
    runnerFactory.runs[0].params.message,
    /@relaybot please answer the channel and attach the plan/
  );
  assert.match(
    runnerFactory.runs[0].params.developerInstructions,
    /REPLY/
  );
  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[0],
    [
      "private scratch text",
      "REPLY",
      "Here is the plan for the channel.",
      "ATTACH ./artifacts/plan.txt"
    ].join("\n")
  );

  assert.deepEqual(botApi.posts, [
    {
      channelId: "town-square",
      message: "Here is the plan for the channel.",
      rootId: null
    },
    {
      channelId: "town-square",
      message: "",
      rootId: null,
      fileIds: ["file-1"]
    }
  ]);
  assert.equal(botApi.uploads.length, 1);
  assert.equal(botApi.uploads[0].channelId, "town-square");
  assert.equal(botApi.uploads[0].filePath, planPath);
});

test("Mattermost group E2E batches busy group posts and replies only through REPLY blocks", async () => {
  const { runtime, botApi, runnerFactory, workdir } = await createRuntime();
  botApi.channels.set("town-square", { id: "town-square", type: "O" });
  botApi.users.set("u1", { id: "u1", username: "alice" });
  botApi.users.set("u2", { id: "u2", username: "bob" });
  botApi.users.set("u3", { id: "u3", username: "carol" });
  const artifactDir = path.join(workdir, "artifacts");
  const photoPath = path.join(artifactDir, "rollout.png");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(photoPath, "fake png", "utf8");

  await sendPost(runtime, {
    id: "post1",
    channel_id: "town-square",
    user_id: "u1",
    message: "release thread is starting",
    create_at: 1000,
    file_ids: []
  });
  await sendPost(runtime, {
    id: "post2",
    channel_id: "town-square",
    user_id: "u1",
    message: "@relaybot check the migration risk",
    create_at: 2000,
    file_ids: []
  });
  await sendPost(runtime, {
    id: "post3",
    channel_id: "town-square",
    user_id: "u2",
    message: "I will update the changelog separately",
    create_at: 3000,
    file_ids: []
  });
  await sendPost(runtime, {
    id: "post4",
    channel_id: "town-square",
    user_id: "u3",
    message: "@relaybot also attach the rollout image",
    create_at: 4000,
    file_ids: []
  });

  assert.equal(runnerFactory.runs.length, 1);
  await finishRunAndKeepDraining(
    runnerFactory.runs[0],
    "NO_REPLY"
  );
  await waitForRunCount(runnerFactory, 2);

  const queuedGroupPrompt = runnerFactory.runs[1].params.message;
  assert.match(queuedGroupPrompt, /^Messages since your last turn:/);
  assert.match(queuedGroupPrompt, /alice \(@alice\):\n@relaybot check the migration risk/);
  assert.match(queuedGroupPrompt, /bob \(@bob\):\nI will update the changelog separately/);
  assert.match(queuedGroupPrompt, /carol \(@carol\):\n@relaybot also attach the rollout image/);
  assert(
    queuedGroupPrompt.indexOf("@relaybot check the migration risk") <
      queuedGroupPrompt.indexOf("I will update the changelog separately")
  );
  assert(
    queuedGroupPrompt.indexOf("I will update the changelog separately") <
      queuedGroupPrompt.indexOf("@relaybot also attach the rollout image")
  );

  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[1],
    [
      "private scratch text that must stay hidden",
      "REPLY @alice",
      "Migration risk is captured.",
      "REPLY @carol",
      "Rollout image attached.",
      "ATTACH ./artifacts/rollout.png",
      "scratch after the attachment must also stay hidden"
    ].join("\n")
  );

  assert.deepEqual(botApi.posts, [
    {
      channelId: "town-square",
      message: "@alice Migration risk is captured.",
      rootId: null
    },
    {
      channelId: "town-square",
      message: "@carol Rollout image attached.",
      rootId: null
    },
    {
      channelId: "town-square",
      message: "",
      rootId: null,
      fileIds: ["file-1"]
    }
  ]);
  assert.equal(botApi.uploads.length, 1);
  assert.equal(botApi.uploads[0].channelId, "town-square");
  assert.equal(botApi.uploads[0].filePath, photoPath);
});
