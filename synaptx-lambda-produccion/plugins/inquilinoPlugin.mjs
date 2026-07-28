import { BasePlugin } from './basePlugin.mjs';

export class InquilinoPlugin extends BasePlugin {
  constructor(tenantConfig, functions) {
    super(tenantConfig);
    this.pluginType = 'inquilino';
    this.entityType = 'inquilino';
    this.fns = functions || {};
  }

  classifyIntent(_message, _ctx) {
    // Let generic classifier + AI handle menu-style conversation.
    return null;
  }

  async prepareHistory(history, message, ctx) {
    // Keep existing inquilino flow intact by delegating to the legacy memory() function.
    if (typeof this.fns?.memory !== 'function') {
      history.push({ role: 'user', content: message });
      return { history, ctx };
    }

    try {
      const result = await this.fns.memory(
        history,
        message,
        this.config,
        ctx?.sessionId,
        ctx
      );

      if (Array.isArray(result)) return { history: result, ctx };
      return {
        history: result?.history || history,
        ctx: result?.metadata || result?.ctx || ctx
      };
    } catch (err) {
      console.error('InquilinoPlugin.prepareHistory error:', err.message);
      history.push({ role: 'user', content: message });
      return { history, ctx };
    }
  }

  async handleConfirmation(_message, _history, _ctx) {
    return null;
  }

  async processAction(_reply, _history, _ctx) {
    // Inquilino bot currently relies on prompt+context blocks, not action JSON.
    return null;
  }

  async handleImplicitConfirmation(_message, _history, _ctx) {
    return null;
  }

  formatResponse(actionResult, _channel) {
    return actionResult?.reply ?? null;
  }
}
