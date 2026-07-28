// plugins/basePlugin.mjs — Abstract base class for all domain plugins.
// Every rubro-specific plugin extends this and overrides classifyIntent + execute.

export class BasePlugin {
  constructor(tenantConfig) {
    this.config     = tenantConfig;
    this.tenantId   = tenantConfig.tenantId;
    this.pluginType = 'base';
    this.entityType = 'entity';
  }

  /**
   * Domain-specific intent classification (no AI).
   * Return { intent, confidence } with confidence >= 0.85 to skip the generic classifier.
   * Return null to fall through to the generic pattern classifier.
   */
  classifyIntent(_message, _ctx) {
    return null;
  }

  /**
   * Execute a classified intent.
   * Returns an ActionResult: { type, data?, reply?, reason? }
   */
  async execute(_intent, _params, _ctx) {
    return { type: 'unknown' };
  }

  /**
   * Formats an ActionResult into a human-readable string for the given channel.
   * Return null to let the orchestrator fall through to the AI reply.
   */
  formatResponse(_actionResult, _channel = 'whatsapp') {
    return null;
  }

  /**
   * Injects per-turn context into the system prompt.
   * Called by the orchestrator after loading session but before calling memory/AI.
   * Return a string to append to history[0].content, or '' to skip.
   */
  buildContextBlock(ctx) {
    const lines = [];
    if (ctx.activeEntity?.id)
      lines.push(`ENTIDAD_ACTIVA_ID:${ctx.activeEntity.id}`);
    if (ctx.flow)
      lines.push(`FLUJO_ACTIVO:${ctx.flow}`);
    return lines.length ? '\n\n' + lines.join('\n') : '';
  }

  /**
   * Hook called by the orchestrator when the user sends a clear confirmation
   * (si/dale/ok) and there's a pendingAction in the session.
   * Override in plugins that manage their own pending actions.
   * Returns { handled, reply, metadata } or null.
   */
  async handleConfirmation(_message, _history, _ctx) {
    return null;
  }

  /**
   * Hook for implicit confirmations: user said something affirmative without an
   * explicit pending action, but context allows inferring one.
   * Returns { handled, reply, metadata } or null.
   */
  async handleImplicitConfirmation(_message, _history, _ctx) {
    return null;
  }

  /**
   * Called before the AI to enrich history with domain context
   * (property search results, visit list, etc.).
   * Returns { history, ctx } or null (null = orchestrator handles manually).
   */
  async prepareHistory(_history, _message, _ctx) {
    return null;
  }

  /**
   * Called after the AI to execute any JSON action found in the reply.
   * Returns { handled, reply, metadata } or null.
   */
  async processAction(_reply, _history, _ctx) {
    return null;
  }

  // ─── Shared helpers ───────────────────────────────────────────────────────

  norm(str) {
    return String(str || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').trim();
  }

  isPendingValid(pendingAction, ttlMs = 10 * 60 * 1000) {
    if (!pendingAction?.timestamp) return false;
    return Date.now() - pendingAction.timestamp < ttlMs;
  }

  get supabaseConfig() {
    return this.config.supabase;
  }

  get aiConfig() {
    return this.config.ai || this.config;
  }
}
