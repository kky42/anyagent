export function chatBindingKey({ platform, bindingId }) {
  return `${String(platform ?? "").trim().toLowerCase()}:${String(bindingId ?? "").trim()}`;
}

export function runtimeBindingKey(runtime) {
  return chatBindingKey({
    platform:
      runtime?.botConfig?.platform ??
      (runtime?.botConfig?.serverUrl ? "mattermost" : "telegram"),
    bindingId: runtime?.botConfig?.bindingId ?? runtime?.botConfig?.username
  });
}

export class RuntimeRegistry {
  constructor(runtimes = []) {
    this.runtimesByKey = new Map();
    for (const runtime of runtimes) {
      this.add(runtime);
    }
  }

  add(runtime) {
    const key = runtimeBindingKey(runtime);
    const existing = this.runtimesByKey.get(key);
    if (existing && existing !== runtime) {
      throw new Error(`Chat binding runtime is already registered: ${key}`);
    }
    this.runtimesByKey.set(key, runtime);
  }

  removeByKey(key) {
    const runtime = this.runtimesByKey.get(key) ?? null;
    this.runtimesByKey.delete(key);
    return runtime;
  }

  replaceByKey(key, runtime) {
    this.runtimesByKey.set(key, runtime);
  }

  find({ platform, bindingId }) {
    return this.runtimesByKey.get(chatBindingKey({ platform, bindingId })) ?? null;
  }

  forAgent(agentId) {
    const normalizedAgentId = String(agentId ?? "").trim();
    return this.runtimes.filter(
      (runtime) => runtime?.botConfig?.agent?.id === normalizedAgentId
    );
  }

  get runtimes() {
    return [...this.runtimesByKey.values()];
  }
}
