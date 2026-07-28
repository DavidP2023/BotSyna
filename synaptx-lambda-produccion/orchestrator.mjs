// orchestrator.mjs — Core bot orchestrator (plugin-based, AI-optional).
//
// Decision pipeline per message:
//   1. Load session (DynamoDB)
//   2. Ensure system prompt is at history[0]
//   3. If pending action + clear confirmation  → execute directly (no AI)
//   4. plugin.prepareHistory()                 → enrich context (search, visit list, etc.)
//   5. classifyIntent()                        → pattern match or needs_ai
//   6. Direct-intent shortcuts                 → thanks, etc. (no AI)
//   7. OpenAI call
//   8. Extract JSON action → plugin.processAction()
//   9. Implicit confirmation → plugin.handleImplicitConfirmation()
//  10. Clean reply, save session, return

import OpenAI from "openai";
import { classifyIntent }                      from './intentClassifier.mjs';
import { loadSession, saveSession, trimHistory } from './sessionStore.mjs';
import { createPlugin }                        from './pluginFactory.mjs';
import { buildResponseContextBlock }           from './services/responseContextBuilder.mjs';
import { validateAndRepairResponse }           from './services/responseValidator.mjs';

// ─── Utility helpers ─────────────────────────────────────────────────────────

function esConfirmacionClara(msg = '') {
  const m = String(msg).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').trim()
    .replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ');
  return (
    /^(si|s|dale|ok|okay|confirmo|confirmado|de\s*una|perfecto|listo|hagamoslo|hacelo|procede|proceda|claro|va|sale|bueno|exacto)$/.test(m) ||
    /\b(si|dale|ok|confirmo|confirmado|procede)\b/.test(m)
  );
}

function esSolicitudCancelacionDirecta(msg = '') {
  const m = String(msg).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').trim();
  return /\b(cancelar|cancela|cancele|cancelalo|cancelala|anular|anula|dar de baja|baja la visita|quiero cancelar)\b/.test(m);
}

function _findActionJSON(text) {
  const s = String(text || '');
  const actionRe = /"action"\s*:\s*"(?:reserve|update_visit|cancel_visit)"/;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{') {
      let depth = 0, j = i;
      while (j < s.length) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      const candidate = s.slice(i, j + 1);
      if (actionRe.test(candidate)) return { start: i, end: j + 1, text: candidate };
    }
    i++;
  }
  return null;
}

function limpiarJSON(reply = '') {
  let s = String(reply || '')
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*json\s*$/gim, '');
  // Strip complete JSON objects with action fields (handles nested braces correctly)
  let match;
  while ((match = _findActionJSON(s)) !== null) {
    s = s.slice(0, match.start) + s.slice(match.end);
  }
  return s.trim();
}

// Saludo/presentación inicial que el prompt instruye a usar SOLO en el primer mensaje
// de la conversación. La LLM no siempre respeta esa instrucción de forma consistente,
// así que se refuerza acá: si ya hubo un mensaje previo del bot en la sesión, se recorta
// cualquier presentación repetida al inicio de la respuesta.
const SALUDO_REPETIDO_RE = /^\s*¡?hola!?\s*[.,!]?\s*(?:soy\s+valen\s*,?\s*(?:de\s+salom[oó]n\s+inmobiliaria)?\s*[.,!]?\s*)?/i;

function quitarSaludoRepetido(reply = '') {
  const sinSaludo = String(reply || '').replace(SALUDO_REPETIDO_RE, '').trim();
  return sinSaludo || reply;
}

function sanitizeUserReply(reply = '') {
  let s = String(reply || '');

  // Remove code fences and action JSON snippets first.
  s = s.replace(/```json[\s\S]*?```/gi, '').replace(/```[\s\S]*?```/g, '');
  s = limpiarJSON(s);

  // Remove lines with internal technical markers that should never reach users.
  const technicalLine = /(DATA:|ID interno|IDS_PROPIEDADES_MOSTRADAS|DIRS_PROPIEDADES_MOSTRADAS|PROPIEDAD_SELECCIONADA_ID|PENDING_ACTION|END_PENDING_ACTION|BUSQUEDA:|PK\b|SK\b|tenantId|metadata|\bctx\b|\bUUID\b|\btabla\b|\bcolumna\b)/i;
  s = s
    .split('\n')
    .filter(line => !technicalLine.test(line))
    .join('\n');

  // Drop standalone JSON-looking lines if any still survive.
  s = s.replace(/^\s*[\[{].*[\]}]\s*$/gm, '');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function extractActionJSON(text) {
  const match = _findActionJSON(text);
  if (!match) return null;
  try   { return JSON.parse(match.text); }
  catch { return null; }
}

function esTurnoBusquedaListado({ message = '', intent = null, ctx = {} }) {
  const m = String(message || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ' ');
  const byIntent =
    intent?.intent === 'search'
    || intent?.structured?.intent === 'search_property'
    || ctx?.lastIntent?.intent === 'search_property';

  const byMessage = /\b(busco|buscando|buscar|mostrame|mostrar|quiero ver|quiero buscar|hay|tenes|tienen|departamento|depto|casa|ph|duplex|local|oficina|cochera|propiedad(?:es)?|opciones?)\b/.test(m)
    && !/\b(cancelar|cancelacion|anular|reprogramar|cambiar visita|confirmo|confirmar reserva|agendar|reservar visita|id\s*[:#]?\s*\d+)\b/.test(m);

  return byIntent || byMessage;
}

// ─── Direct-intent responses (no AI needed) ──────────────────────────────────

const DIRECT_RESPONSES = {
  thanks:   () => '¡De nada! Cuando necesitás algo más, estoy acá.',
  escalate: (cfg) =>
    cfg?.channel?.humanHandoffMessage ||
    'Te voy a conectar con un asesor en un momento. Por favor, esperá.',
  // Determinístico: el link ya fue resuelto en plugin.prepareHistory (PASO 8) y quedó
  // en ctx.materialLinkActivo. No depende de que la IA decida usarlo bien.
  material_propiedad: (_cfg, ctx) => `Más información:\n${ctx?.materialLinkActivo || ''}`.trim(),
};

// ─── Main orchestrator ───────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object}      opts.tenantConfig - Full tenant_config.json
 * @param {object|null} opts.functions    - Loaded functions.mjs module from S3
 * @param {string}      opts.sessionId   - User identifier (phone, email, etc.)
 * @param {string}      opts.message     - Raw inbound message text
 * @param {string}      opts.prompt      - Compiled system prompt (with date injected)
 * @returns {Promise<string>} Bot reply text
 */
export async function orchestrate({ tenantConfig, functions, sessionId, message, prompt }) {
  const tenantId = tenantConfig.tenantId;
  const limits   = tenantConfig.limits   || {};
  const aiCfg    = tenantConfig.ai       || tenantConfig;
  const responseGuardMode = 'block';
  const includeBackendContext = true;
  const maxMsgs  = (limits.sessionHistoryMessages || 15) * 2;
  const ttlDays  = limits.sessionTTLDays || 30;

  const plugin = createPlugin(tenantConfig, functions);

  // 1. Load session
  const session = await loadSession(tenantId, sessionId);
  let { history, ctx, tokensUsed } = session;
  ctx.sessionId = sessionId;
  ctx.tenantId  = tenantId;
  const yaHuboSaludoPrevio = history.some(m => m.role === 'assistant');

  // 2. Ensure system prompt is at history[0]
  if (!history.length || history[0]?.role !== 'system') {
    history = [{ role: 'system', content: prompt || '' }, ...history];
  }
  // NUNCA pisar history[0].content con el prompt base en cada turno: eso borra las
  // etiquetas dinámicas (PROPIEDAD_SELECCIONADA_ID, BUSQUEDA:, FILTRO_*, IDS/DIRS_
  // PROPIEDADES_MOSTRADAS) que plugin.prepareHistory fue inyectando en turnos
  // anteriores, y con ellas el caché que evita re-disparar una búsqueda nueva en
  // cada mensaje — esa re-búsqueda espuria es la que reseteaba la propiedad ya
  // elegida por el cliente. El refresco de fecha lo hace cada plugin sobre el
  // contenido EXISTENTE (ver PropertyPlugin.prepareHistory, PASO 0).

  const isConfirm = esConfirmacionClara(message);
  const isDirectCancelRequest = esSolicitudCancelacionDirecta(message);
  const shouldForcePending = Boolean(
    ctx.pendingAction && (
      isConfirm
      || (ctx.pendingAction?.type === 'cancel_visit' && isDirectCancelRequest)
    )
  );

  // 3. Server-side pending action confirmation (no AI, no extra latency)
  if (shouldForcePending && plugin.isPendingValid(ctx.pendingAction)) {
    const result = await plugin.handleConfirmation(message, history, ctx);
    if (result?.handled) {
      const reply = sanitizeUserReply(result.reply || 'Acción confirmada.');
      ctx = { ...(result.metadata || ctx), pendingAction: null };
      await _persist({ tenantId, sessionId, history, ctx, reply, maxMsgs, ttlDays, tokensUsed: 0 });
      return reply;
    }
  }

  // 4. Plugin context enrichment (property search, visit list, pending action injection, etc.)
  const enriched = await plugin.prepareHistory(history, message, ctx);
  if (enriched) {
    history = enriched.history || history;
    ctx     = enriched.ctx     || ctx;
  } else {
    history.push({ role: 'user', content: message });
  }

  // 5. Intent classification (plugin patterns → generic patterns → AI)
  const pluginIntent = plugin.classifyIntent(message, ctx);
  const intent       = classifyIntent(message, pluginIntent);
  ctx.lastIntent     = intent?.structured || { intent: intent?.intent || 'unknown', source: intent?.source || 'unknown', confidence: intent?.confidence || 0 };

  // 6. Direct-intent shortcuts
  const directFn = DIRECT_RESPONSES[intent.intent];
  if (directFn) {
    const reply = directFn(tenantConfig, ctx);
    await _persist({ tenantId, sessionId, history, ctx, reply, maxMsgs, ttlDays, tokensUsed: 0 });
    return reply;
  }

  // 7. Call OpenAI
  const openai = new OpenAI({
    apiKey: tenantConfig.openai_api_key || aiCfg.openai_api_key || process.env.OPENAI_API_KEY
  });

  let completion;
  try {
    const responseContext = includeBackendContext
      ? buildResponseContextBlock({ message, ctx })
      : '';
    const aiMessages = responseContext
      ? [...history, { role: 'system', content: responseContext }]
      : history;

    completion = await openai.chat.completions.create({
      model:             aiCfg.model             || 'gpt-4o-mini',
      messages:          aiMessages,
      max_tokens:        aiCfg.max_tokens         || 800,
      temperature:       aiCfg.temperature        ?? 0.4,
      top_p:             aiCfg.top_p,
      frequency_penalty: aiCfg.frequency_penalty,
      presence_penalty:  aiCfg.presence_penalty,
    });
  } catch (err) {
    console.error('orchestrator: OpenAI error:', err.message);
    return 'Tuvimos un problema temporal. Podés reintentar en un momento.';
  }

  let reply     = completion.choices?.[0]?.message?.content || '';
  const newTokens = completion.usage?.total_tokens || 0;
  tokensUsed   = (tokensUsed || 0) + newTokens;

  // 8. Extract JSON action and process
  let actionHandled = false;
  const actionJSON  = extractActionJSON(reply);

  if (actionJSON) {
    const result = await plugin.processAction(reply, history, ctx);
    if (result) {
      actionHandled = result.handled !== false;
      if (actionHandled) {
        reply = result.reply || reply;
        ctx   = result.metadata || ctx;
      }
    }
  }

  // 9. Implicit confirmation (affirmative message, no JSON from AI, no action handled yet)
  if (!actionHandled && (isConfirm || isDirectCancelRequest)) {
    const result = await plugin.handleImplicitConfirmation(message, history, ctx);
    if (result?.handled) {
      actionHandled = true;
      reply = result.reply || reply;
      ctx   = result.metadata || ctx;
    }
  }

  // 10. Clean reply
  if (!actionHandled) {
    reply = sanitizeUserReply(reply);
    if (yaHuboSaludoPrevio) reply = quitarSaludoRepetido(reply);

    // Anti-hallucination guard: if reply claims success but no DB action ran, block it
    const looksLikeSuccess = /visita\s+agendada|reserva\s+confirmada|visita\s+cancelada|turno\s+confirmado|qued[oó]\s+agendad[ao]|nos\s+vemos\s+el|visita\s+est[aá]\s+confirmada|tu\s+visita\s+est[aá]\s+confirmada|confirmaste\s+mi\s+visita|ya\s+est[aá]\s+confirmada|te\s+confirmo\s+la\s+visita|te\s+espero\s+el|quedamos\s+para\s+visitar|listo\W+te\s+espero/i.test(reply);
    const userInActionFlow = Boolean(ctx.pendingAction) ||
      /(agendar|reservar|visitar|confirmar|turno|visita)/i.test(message);
    const confirmWithoutAction = isConfirm && /(visita|reserva|turno)/i.test(String(message || ''));
    if ((looksLikeSuccess && userInActionFlow) || confirmWithoutAction) {
      reply = 'Para confirmarlo necesito verificarlo en el sistema primero. ¿Continuamos?';
    }

    if (!String(reply).trim()) {
      reply = '¿En qué más te puedo ayudar?';
    }
  }

  reply = sanitizeUserReply(reply);

  if (responseGuardMode !== 'off') {
    const validated = validateAndRepairResponse({ reply, ctx });
    if (validated?.blocked) {
      console.warn('orchestrator: response validator flagged reply:', validated.reasons?.join('|'));
      const isSearchListTurn = esTurnoBusquedaListado({ message, intent, ctx });

      // In list-search turns we keep guard visibility (warn) but avoid hard blocks
      // so property listings are not replaced by generic fallback text.
      if (responseGuardMode === 'block' && !isSearchListTurn) {
        reply = validated.reply;
      }
    }
  }

  if (/^[\s{}\[\],.:;"'`_-]+$/.test(String(reply || ''))) {
    reply = 'No pude confirmar la acción en este paso. Escribime "si confirmo" y la ejecuto ahora mismo.';
  }

  // 11. Persist session
  await _persist({ tenantId, sessionId, history, ctx, reply, maxMsgs, ttlDays, tokensUsed });
  return reply;
}

// ─── Internal: persist session ───────────────────────────────────────────────

async function _persist({ tenantId, sessionId, history, ctx, reply, maxMsgs, ttlDays, tokensUsed }) {
  const finalHistory = trimHistory(
    [...history, { role: 'assistant', content: reply, timestamp: new Date().toISOString() }],
    maxMsgs
  );
  await saveSession(tenantId, sessionId, finalHistory, ctx, tokensUsed, ttlDays);
}
