export class AgentOperationLocks {
  constructor() {
    this.tails = new Map();
  }

  async runExclusive(agentId, fn) {
    const key = String(agentId ?? "").trim();
    if (!key) {
      throw new Error("agent id is required for operation lock");
    }

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  async wait(agentId) {
    const key = String(agentId ?? "").trim();
    if (!key) {
      return;
    }
    await (this.tails.get(key) ?? Promise.resolve()).catch(() => {});
  }
}
