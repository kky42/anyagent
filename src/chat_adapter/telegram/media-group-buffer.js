function mediaGroupKey(session, mediaGroupId) {
  return `${session.chatId}:${session.conversationId}:${mediaGroupId}`;
}

export class MediaGroupBuffer {
  constructor({ quietPeriodMs }) {
    this.quietPeriodMs = quietPeriodMs;
    this.pendingMediaGroups = new Map();
  }

  hasPending() {
    return this.pendingMediaGroups.size > 0;
  }

  queue(session, message, handleMessages = (messages) => session.handleAttachmentMessages(messages)) {
    const mediaGroupId = message?.media_group_id;
    if (!mediaGroupId) {
      return typeof handleMessages === "function" ? handleMessages([message]) : undefined;
    }

    const key = mediaGroupKey(session, mediaGroupId);
    const existing = this.pendingMediaGroups.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const entry = existing ?? {
      session,
      messages: [],
      handleMessages: null
    };
    if (typeof handleMessages === "function") {
      entry.handleMessages = handleMessages;
    }
    entry.messages.push(message);
    entry.timer = setTimeout(() => {
      void this.flush(key);
    }, this.quietPeriodMs);

    this.pendingMediaGroups.set(key, entry);
    return undefined;
  }

  async flush(key) {
    const entry = this.pendingMediaGroups.get(key);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pendingMediaGroups.delete(key);
    if (typeof entry.handleMessages === "function") {
      await entry.handleMessages(entry.messages);
    }
  }

  clear() {
    for (const entry of this.pendingMediaGroups.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingMediaGroups.clear();
  }
}
