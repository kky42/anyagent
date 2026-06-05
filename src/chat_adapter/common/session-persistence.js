import {
  ConversationState,
  ConversationStateStore
} from "./conversation-state.js";

export const NOOP_CONFIG_STORE = {
  async loadChatBindingConfig() {
    throw new Error("Config reload is unavailable.");
  }
};

export class SessionPersistence {
  static loadSync({
    bindingConfig,
    platform,
    bindingId,
    conversationId,
    deliveryAnchor = null,
    stateStore = new ConversationStateStore(),
    logger = () => {}
  }) {
    const conversationState = ConversationState.loadSync({
      bindingConfig,
      platform,
      bindingId,
      conversationId,
      deliveryAnchor,
      stateStore,
      logger
    });
    return new SessionPersistence({ conversationState });
  }

  static async load({
    bindingConfig,
    platform,
    bindingId,
    conversationId,
    deliveryAnchor = null,
    stateStore = new ConversationStateStore(),
    logger = () => {}
  }) {
    const conversationState = await ConversationState.load({
      bindingConfig,
      platform,
      bindingId,
      conversationId,
      deliveryAnchor,
      stateStore,
      logger
    });
    return new SessionPersistence({ conversationState });
  }

  constructor({ conversationState }) {
    this.conversationState = conversationState;
  }

  get sessionId() {
    return this.conversationState.sessionId;
  }

  get contextLength() {
    return this.conversationState.contextLength;
  }

  get additionalSystemPromptSnapshot() {
    return this.conversationState.additionalSystemPromptSnapshot;
  }

  get cli() {
    return this.conversationState.cli;
  }

  get workdir() {
    return this.conversationState.workdir;
  }

  get auto() {
    return this.conversationState.auto;
  }

  get model() {
    return this.conversationState.model;
  }

  get reasoningEffort() {
    return this.conversationState.reasoningEffort;
  }

  get schedules() {
    return this.conversationState.schedules;
  }

  get deliveryAnchor() {
    return this.conversationState.deliveryAnchor;
  }

  async updateDeliveryAnchor(deliveryAnchor) {
    await this.conversationState.updateDeliveryAnchor(deliveryAnchor);
  }

  async updateSessionId(sessionId, options = {}) {
    await this.conversationState.updateSessionId(sessionId, options);
  }

  async updateContextLength(contextLength) {
    await this.conversationState.updateContextLength(contextLength);
  }

  async clearSessionState() {
    await this.conversationState.clearSessionState();
  }

  async resetChatToBindingDefaults() {
    await this.conversationState.resetChatToBindingDefaults();
  }

  async resetChatToBotDefaults() {
    await this.conversationState.resetChatToBotDefaults();
  }

  async applyRuntimeSettings(patch) {
    await this.conversationState.applyRuntimeSettings(patch);
  }

  async replaceSchedules(schedules) {
    await this.conversationState.replaceSchedules(schedules);
  }
}
