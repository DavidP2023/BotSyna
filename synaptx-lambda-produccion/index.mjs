// index.mjs — Lambda WhatsApp + Web + Chatwoot (Multi-tenant por PNID + Dedup + Solo texto)
// - Router: DynamoDB SynaptxWabaBindings (PK = PNID#<phone_number_id>)
// - Dedup: DynamoDB SynaptxWebhookDedup (PK = WA_MSG#<messageId>, TTL attr = expiresAt)
// - Envío WhatsApp centralizado con token por binding (metaAccessToken)
// - Chatwoot: registra incoming/outgoing y silencia bot si hay humano activo/asignado
// - Orchestrator: nuevo path de plugins cuando tenant_config.json tiene campo "plugin"
//
// Env vars requeridas:
// - BOTS_BUCKET
// - OPENAI_API_KEY
// - WHATSAPP_VERIFY_TOKEN
// - BINDINGS_TABLE=SynaptxWabaBindings
// - DEDUP_TABLE=SynaptxWebhookDedup
// Chatwoot (opcional):
// - CHATWOOT_BASE_URL
// - CHATWOOT_ACCOUNT_ID, CHATWOOT_INBOX_ID, CHATWOOT_API_TOKEN (fallback si el binding no trae creds)
//
// Opcional fallback temporal (NO recomendado para multi-tenant real):
// - ALLOW_GLOBAL_WA_FALLBACK=true  (si falta metaAccessToken en binding, usa WHATSAPP_ACCESS_TOKEN)

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import fs from "fs";
import { pathToFileURL } from "url";
import crypto from "crypto";
import OpenAI from "openai";
import { orchestrate } from "./orchestrator.mjs";

/* ================================
   HELPERS
================================ */
async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function getRawBody(event) {
  if (!event?.body) return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return typeof event.body === "string" ? event.body : JSON.stringify(event.body);
}

function safeJsonParse(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Body no parseable:", e.message);
    return {};
  }
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function esConfirmacionClara(msg = "") {
  const m = String(msg)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ");

  return /^(si|s|dale|ok|okay|confirmo|confirmado|de una|perfecto|listo|hagamoslo|hacelo|procede|proceda)$/.test(m)
    || /\b(si|dale|ok|confirmo|confirmado|procede)\b/.test(m);
}

function esSolicitudCancelacionDirecta(msg = "") {
  const m = String(msg)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  return /\b(cancelar|cancela|cancele|cancelalo|cancelala|anular|anula|dar de baja|baja la visita|quiero cancelar)\b/.test(m);
}

function limpiarBloquesJsonInternos(reply = "") {
  let out = String(reply || "");

  // Quitar bloques markdown de codigo para evitar exponer payloads internos.
  out = out.replace(/```json[\s\S]*?```/gi, "");
  out = out.replace(/```[\s\S]*?```/g, "");

  // Quitar objetos JSON con llaves de acciones/agenda aunque no traigan "action".
  out = out.replace(/\{[\s\S]*?"(?:action|id_propiedad|telefono|fecha|hora|nombre)"[\s\S]*?\}/gi, "");

  // Quitar etiqueta suelta "json" que suele quedar antes del objeto.
  out = out.replace(/^\s*json\s*$/gim, "");

  return out.trim();
}

function verifyMetaSignature({ rawBody, signatureHeader, appSecret }) {
  if (!rawBody || !signatureHeader || !appSecret) return false;
  const [algo, theirDigest] = signatureHeader.split("=");
  if (algo !== "sha256" || !theirDigest) return false;

  const ourDigest = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const a = Buffer.from(theirDigest, "hex");
  const b = Buffer.from(ourDigest, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parsePnidFromBinding(binding) {
  if (!binding) return null;
  if (binding.pnid) return String(binding.pnid);
  if (typeof binding.PK === "string" && binding.PK.startsWith("PNID#")) return binding.PK.replace("PNID#", "");
  return null;
}

/* ================================
   AWS CLIENTS
================================ */
const s3 = new S3Client();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/* ================================
   DYNAMO (BINDINGS + DEDUP)
================================ */
async function getBindingByPnid(pnid) {
  const TableName = process.env.BINDINGS_TABLE;
  if (!TableName) throw new Error("Missing env var BINDINGS_TABLE");

  const PK = `PNID#${pnid}`;
  const res = await ddb.send(new GetCommand({ TableName, Key: { PK } }));
  return res.Item || null;
}

async function getBindingByCwKey(cwKey) {
  const TableName = process.env.BINDINGS_TABLE;
  if (!TableName) throw new Error("Missing env var BINDINGS_TABLE");
  if (!cwKey) return null;

  const res = await ddb.send(
    new QueryCommand({
      TableName,
      IndexName: "GSI1_CWKEY",
      KeyConditionExpression: "cwKey = :cw",
      ExpressionAttributeValues: {
        ":cw": cwKey
      },
      Limit: 2
    })
  );

  const items = res.Items || [];
  if (items.length === 0) return null;

  if (items.length > 1) {
    console.warn(`⚠️ cwKey duplicado en bindings: ${cwKey}. Usando el primero.`);
  }

  return items[0];
}

async function dedupMessageId(messageId) {
  const TableName = process.env.DEDUP_TABLE;
  if (!TableName) throw new Error("Missing env var DEDUP_TABLE");

  const PK = `WA_MSG#${messageId}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 172800; // 48h

  try {
    await ddb.send(
      new PutCommand({
        TableName,
        Item: { PK, expiresAt, createdAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(PK)"
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/* ================================
   WHATSAPP SEND (CENTRALIZED - TEXT)
================================ */
async function sendWhatsAppText({ phoneNumberId, accessToken, to, text }) {
  if (!phoneNumberId) throw new Error("sendWhatsAppText: missing phoneNumberId");
  if (!accessToken) throw new Error("sendWhatsAppText: missing accessToken");
  if (!to) throw new Error("sendWhatsAppText: missing to");

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text || "" }
    })
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed ${res.status} ${res.statusText}: ${errTxt}`);
  }

  return true;
}

/* ================================
   CHATWOOT INTEGRATION (MULTI-TENANT BY BINDING + OPTIONAL GLOBAL FALLBACK)
================================ */

// NOTE: Inbound (WhatsApp -> Chatwoot) usa el binding pnid para accountId/inboxId/apiToken.
// Fallback a env vars globales si el binding no tiene esos campos.
function cwHeaders(apiToken) {
  return {
    "Content-Type": "application/json",
    api_access_token: apiToken
  };
}

function resolveChatwootConfig(binding) {
  const base = process.env.CHATWOOT_BASE_URL?.replace(/\/$/, "");

  // fallback global (si faltan en binding)
  const accountId = binding?.chatwootAccountId ?? process.env.CHATWOOT_ACCOUNT_ID;
  const inboxId = binding?.chatwootInboxId ?? process.env.CHATWOOT_INBOX_ID;
  const apiToken = binding?.chatwootApiToken ?? process.env.CHATWOOT_API_TOKEN;

  if (!base || !accountId || !inboxId || !apiToken) return null;

  return {
    base,
    accountId: String(accountId),
    inboxId: String(inboxId),
    apiToken: String(apiToken)
  };
}

function chatwootEnabled(cw) {
  return !!(cw?.base && cw?.accountId && cw?.inboxId && cw?.apiToken);
}

async function chatwootFindOrCreateConversation(cw, phone) {
  if (!chatwootEnabled(cw)) {
    console.log("Chatwoot no configurado completamente. Saltando integración.");
    return null;
  }

  const { base, accountId, inboxId, apiToken } = cw;
  const headers = cwHeaders(apiToken);

  try {
    const searchRes = await fetch(
      `${base}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(phone)}`,
      { headers }
    );
    const searchData = await searchRes.json();
    let contact = searchData?.payload?.[0];

    if (!contact) {
      const createRes = await fetch(`${base}/api/v1/accounts/${accountId}/contacts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          inbox_id: Number(inboxId),
          name: `WhatsApp ${phone}`,
          phone_number: `+${phone}`
        })
      });
      if (!createRes.ok) throw new Error("Error creando contacto en Chatwoot");
      const data = await createRes.json();
      contact = data?.payload?.contact || data?.payload || data?.contact || data;
    }

    const convosRes = await fetch(
      `${base}/api/v1/accounts/${accountId}/contacts/${contact.id}/conversations`,
      { headers }
    );
    const convosData = await convosRes.json();
    const convosPayload = Array.isArray(convosData.payload)
      ? convosData.payload
      : Array.isArray(convosData.payload?.conversations)
        ? convosData.payload.conversations
        : [];

    let conversation = convosPayload.find(c => c.inbox_id == inboxId && c.status === "open");

    if (!conversation) {
      const createConvRes = await fetch(`${base}/api/v1/accounts/${accountId}/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          inbox_id: Number(inboxId),
          contact_id: contact.id,
          source_id: phone
        })
      });
      if (!createConvRes.ok) throw new Error("Error creando conversación");
      conversation = await createConvRes.json();
    }

    const convId =
      conversation?.id ||
      conversation?.conversation?.id ||
      conversation?.payload?.conversation?.id ||
      conversation?.payload?.id ||
      conversation?.payload?.conversation_id ||
      conversation?.data?.conversation?.id ||
      conversation?.data?.id ||
      null;

    console.log(
      `Chatwoot(${accountId}/${inboxId}): contacto=${contact?.id} conversation_raw=`,
      typeof conversation === "object" ? JSON.stringify(conversation).slice(0, 400) : conversation
    );
    console.log(`Chatwoot(${accountId}/${inboxId}): resolved conversationId=${convId}`);

    return { conversationId: convId, contactId: contact?.id || null, inboxId: Number(inboxId) };
  } catch (err) {
    console.error("Error en Chatwoot:", err.message);
    return null;
  }
}

async function chatwootSendMessage(cw, conversationCtx, content, type = "incoming", isBot = false) {
  if (!conversationCtx || !chatwootEnabled(cw)) return;

  const { base, accountId, apiToken } = cw;
  const headers = cwHeaders(apiToken);

  let conversationId = conversationCtx;
  let contactId = null;
  let inboxId = null;
  if (typeof conversationCtx === "object") {
    conversationId = conversationCtx.conversationId;
    contactId = conversationCtx.contactId;
    inboxId = conversationCtx.inboxId;
  }

  try {
    const payload = { content, message_type: type, content_type: "text" };
    if (isBot) {
      payload.private = false;
      payload.content = `[BOT] ${content}`;
    }

    let res = null;

    if (conversationId) {
      console.log(`Chatwoot(${accountId}): enviando mensaje a conversation ${conversationId} payload=`, payload);
      res = await fetch(`${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
    } else if (contactId && inboxId) {
      res = await fetch(`${base}/api/v1/accounts/${accountId}/inboxes/${inboxId}/contacts/${contactId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
    } else {
      return;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`Chatwoot: error POST messages ${res.status} ${res.statusText} - ${txt}`);
    } else {
      console.log(`Chatwoot: message posted (${res.status})`);
    }
  } catch (err) {
    console.error("Error enviando mensaje a Chatwoot:", err.message);
  }
}

async function chatwootIsAssigned(cw, conversationId) {
  if (!conversationId || !chatwootEnabled(cw)) return false;

  const { base, accountId, apiToken } = cw;
  const headers = cwHeaders(apiToken);

  try {
    const res = await fetch(`${base}/api/v1/accounts/${accountId}/conversations/${conversationId}`, {
      headers
    });
    if (!res.ok) return false;

    const data = await res.json();
    const conv = data.payload?.conversation || data.payload || data;

    const assigneeId =
      conv.assignee_id ??
      conv.assignee?.id ??
      conv.meta?.assignee?.id ??
      conv.meta?.assignee_id ??
      null;

    const assigned = !!assigneeId;
    console.log(`Asignación detectada: conversation ${conversationId} → assigneeId=${assigneeId} → assigned=${assigned}`);
    return assigned;
  } catch (err) {
    console.error("Error verificando asignación Chatwoot:", err.message);
    return false;
  }
}

async function chatwootHasRecentHumanMessage(cw, conversationId) {
  if (!conversationId || !chatwootEnabled(cw)) return false;

  const { base, accountId, apiToken } = cw;
  const headers = cwHeaders(apiToken);

  try {
    const res = await fetch(`${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      headers
    });
    if (!res.ok) return false;

    const data = await res.json();

    let messages = [];
    if (Array.isArray(data.payload)) messages = data.payload;
    else if (Array.isArray(data.payload?.messages)) messages = data.payload.messages;
    else messages = data.payload || [];

    console.log(`chatwootHasRecentHumanMessage: ${messages.length} mensajes en conversación ${conversationId}`);
    if (messages.length === 0) return false;

    const recentMsgs = messages.slice(-10);
    for (const msg of recentMsgs) {
      const senderType = msg.sender_type || msg.sender?.type;
      const msgType = msg.message_type;
      const content = msg.content || "";

      if (content.startsWith("[BOT]")) continue;
      if (msg.private) continue;

      const isOutgoing = msgType === "outgoing" || msgType === "outgoing_message";
      const isFromAgent =
        senderType === "user" ||
        senderType === "agent" ||
        (isOutgoing && !senderType);

      if (isOutgoing && isFromAgent) {
        console.log(`🤐 HUMANO ACTIVO detectado: "${content.slice(0, 60)}..."`);
        return true;
      }
    }

    console.log(`✅ No hay mensajes recientes de humano en conversación ${conversationId}`);
    return false;
  } catch (err) {
    console.error("Error verificando mensajes recientes:", err.message);
    return false;
  }
}

/* ================================
   LOAD BOT FILES FROM S3
================================ */
async function loadBotFiles(botId) {
  const baseKey = `bots/${botId}/`;
  let config, prompt, functions = {};

  // Try tenant_config.json first (new generic format), fall back to config.json
  try {
    const cfg = await s3.send(new GetObjectCommand({
      Bucket: process.env.BOTS_BUCKET,
      Key: `${baseKey}tenant_config.json`
    }));
    config = JSON.parse(await streamToString(cfg.Body));
    console.log(`loadBotFiles: loaded tenant_config.json for ${botId}`);
  } catch {
    const cfg = await s3.send(new GetObjectCommand({
      Bucket: process.env.BOTS_BUCKET,
      Key: `${baseKey}config.json`
    }));
    config = JSON.parse(await streamToString(cfg.Body));
    console.log(`loadBotFiles: loaded config.json for ${botId}`);
  }

  const prm = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.BOTS_BUCKET,
      Key: `${baseKey}prompt.txt`
    })
  );
  prompt = await streamToString(prm.Body);

  try {
    const fn = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.BOTS_BUCKET,
        Key: `${baseKey}functions.mjs`
      })
    );
    const fnText = await streamToString(fn.Body);
    const tmpPath = `/tmp/${botId}-functions.mjs`;
    fs.writeFileSync(tmpPath, fnText, "utf8");
    const mod = await import(pathToFileURL(tmpPath).href);
    functions = mod.default ?? mod;
  } catch {
    console.warn(`functions.mjs no encontrado para ${botId} → usando vacío`);
    functions = {};
  }

  return { config, prompt, functions };
}

/* ================================
   PROCESS CHAT
================================ */
async function processChat({ botId, sessionId, message }) {
  const { config, prompt, functions } = await loadBotFiles(botId);

  const effectiveConfig = {
    ...config,
    model:       process.env.MODEL       || config.model                                            || "gpt-4o-mini",
    max_tokens:  process.env.MAX_TOKENS  ? Number(process.env.MAX_TOKENS)  : config.max_tokens       || 800,
    temperature: process.env.TEMPERATURE ? Number(process.env.TEMPERATURE) : config.temperature      || 0.7
  };

  // ── New orchestrator path ─────────────────────────────────────────────────
  // Activated when tenant_config.json declares a plugin type.
  // Falls through to the legacy path when plugin is absent (backward compat).
  if (config.plugin) {
    const fechaHoy = functions.obtenerFechaHoyArgentina
      ? functions.obtenerFechaHoyArgentina()
      : (() => {
          const h = new Date();
          return `${String(h.getDate()).padStart(2,'0')}/${String(h.getMonth()+1).padStart(2,'0')}/${h.getFullYear()}`;
        })();
    const dateContext = functions.generarContextoFechas ? functions.generarContextoFechas() : '';
    const fullPrompt  = (prompt || '').replace('{{current_date}}', fechaHoy)
      + (dateContext ? `\n\n${dateContext}` : '');

    const reply = await orchestrate({
      tenantConfig: effectiveConfig,
      functions,
      sessionId,
      message,
      prompt: fullPrompt
    });
    return { reply };
  }
  // ─────────────────────────────────────────────────────────────────────────
  // Legacy path below — unchanged, kept for bots that don't have config.plugin

  const openai = new OpenAI({
    apiKey: effectiveConfig.openai_api_key || process.env.OPENAI_API_KEY
  });

  let history = [];
  let sessionMetadata = {};
  if (functions.loadHistory) {
    try {
      const loaded = await functions.loadHistory(botId, sessionId);
      // Backward compat: loadHistory may return plain array or { history, metadata }
      if (Array.isArray(loaded)) {
        history = loaded;
      } else {
        history = loaded.history || [];
        sessionMetadata = loaded.metadata || {};
      }
      console.log(`loadHistory: Length ${history.length} for ${sessionId}`);
    } catch {
      history = [];
    }
  }

  const fechaHoy = functions.obtenerFechaHoyArgentina
    ? functions.obtenerFechaHoyArgentina()
    : (() => {
        const hoy = new Date();
        const dd = String(hoy.getDate()).padStart(2, '0');
        const mm = String(hoy.getMonth() + 1).padStart(2, '0');
        const yyyy = hoy.getFullYear();
        return `${dd}/${mm}/${yyyy}`;
      })();
  const dateContext = functions.generarContextoFechas ? functions.generarContextoFechas() : '';
  const systemPrompt = (prompt || "").replace("{{current_date}}", fechaHoy) + (dateContext ? `\n\n${dateContext}` : '');

  // Asegurar que history[0] sea siempre el system prompt para que memory()
  // pueda inyectar filtros y datos en él desde el primer turno.
  if (history.length === 0 || history[0]?.role !== 'system') {
    history = [{ role: 'system', content: systemPrompt }, ...history];
  }

  if (functions.memory) {
    // IMPORTANT: pasar sessionId para que el bot pueda buscar cliente por telefono (si su memory lo usa)
    const memResult = await functions.memory(history, message, effectiveConfig, sessionId, sessionMetadata);
    // Backward compat: memory() may return plain array or { history, metadata }
    if (Array.isArray(memResult)) {
      history = memResult;
    } else {
      history = memResult.history || history;
      sessionMetadata = memResult.metadata || sessionMetadata;
    }
  } else {
    history.push({ role: "user", content: message });
  }

  // Atajo server-side: si hay acción pendiente y el usuario confirma, ejecutar sin depender del LLM
  const isAffirmative = esConfirmacionClara(message);
  const isDirectCancelRequest = esSolicitudCancelacionDirecta(message);
  const shouldForcePending = Boolean(
    sessionMetadata?.pendingAction && (
      isAffirmative
      || (sessionMetadata.pendingAction?.type === 'cancel_visit' && isDirectCancelRequest)
    )
  );

  if (shouldForcePending && functions.processReservation) {
    console.log("CONFIRMATION DETECTED");
    console.log("PENDING ACTION:", sessionMetadata.pendingAction);
    const pa = sessionMetadata.pendingAction;
    let forcedPayload = null;
    if (pa.type === 'reserve') forcedPayload = { action: 'reserve', ...(pa.data || {}) };
    if (pa.type === 'cancel_visit') forcedPayload = { action: 'cancel_visit', id: pa.data?.id };
    if (pa.type === 'update_visit') forcedPayload = { action: 'update_visit', id: pa.data?.id, ...(pa.data?.updateData || {}) };

    if (forcedPayload) {
      try {
        const result = await functions.processReservation(
          JSON.stringify(forcedPayload),
          effectiveConfig,
          true,
          history,
          sessionId,
          sessionMetadata,
          { forceExecutePending: true }
        );
        const forcedReply = result?.reply || 'No pude procesar la acción solicitada.';
        sessionMetadata = result?.metadata || sessionMetadata;

        if (functions.saveHistory) {
          try {
            const finalHistory = [...history, { role: "assistant", content: forcedReply }];
            await functions.saveHistory(botId, sessionId, finalHistory, 0, sessionMetadata);
          } catch (err) {
            console.error("saveHistory error (forced action):", err.message);
          }
        }

        return { reply: forcedReply };
      } catch (err) {
        console.error("Error en processReservation (forced action):", err.message);
        return { reply: 'Tuvimos un inconveniente para confirmar la visita en este momento.\nSi querés, lo reintentamos ahora en un mensaje y te acompaño paso a paso.' };
      }
    }
  }

  // history[0] ya es el system prompt (inyectado arriba o cargado de DynamoDB)
  const completion = await openai.chat.completions.create({
    model: effectiveConfig.model,
    messages: history,
    max_tokens: effectiveConfig.max_tokens,
    temperature: effectiveConfig.temperature
  });

  let reply = completion.choices?.[0]?.message?.content || "";

  const jsonMatch = reply.match(/\{[\s\S]*?"action"\s*:\s*"(?:reserve|update_visit|cancel_visit)"[\s\S]*?\}/);
  let actionHandled = false;
  if (jsonMatch && functions.processReservation) {
    try {
      const result = await functions.processReservation(reply, effectiveConfig, true, history, sessionId, sessionMetadata);
      reply = result?.reply || 'No pude procesar la acción solicitada.';
      sessionMetadata = result?.metadata || sessionMetadata;
      actionHandled = result?.handled !== false;
    } catch (err) {
      console.error("Error en processReservation:", err.message);
      reply = 'No pude procesar la acción solicitada por un error interno.';
      actionHandled = true;
    }
  }

  // Hook opcional por tenant: el bot puede manejar confirmaciones implicitas sin JSON.
  if (!actionHandled && (isAffirmative || isDirectCancelRequest) && typeof functions.handleImplicitConfirmation === "function") {
    try {
      const result = await functions.handleImplicitConfirmation({
        message,
        history,
        sessionId,
        metadata: sessionMetadata,
        config: effectiveConfig
      });

      if (result?.handled) {
        reply = result?.reply || reply;
        sessionMetadata = result?.metadata || sessionMetadata;
        actionHandled = true;
      }
    } catch (err) {
      console.error("Error en hook handleImplicitConfirmation:", err.message);
    }
  }

  if (!actionHandled) {
    reply = reply.replace(/\{[\s\S]*?"action"\s*:\s*"(?:reserve|update_visit|cancel_visit)"[\s\S]*?\}/g, "").trim();
    reply = limpiarBloquesJsonInternos(reply);

    // Barrera anti falso positivo: si no hubo acción backend, bloquear respuestas finales de "confirmado".
    const pareceExitoAccion = /visita\s+agendada|reserva\s+confirmada|visita\s+cancelada|visita\s+actualizada|te\s+anoto\s+para\s+la\s+visita|todo\s+confirmado|nos\s+vemos\s+el|qued[oó]\s+agendada|con\s+[eé]xito|te\s+confirmo\s+la\s+visita|te\s+espero\s+el|quedamos\s+para\s+visitar|listo\W+te\s+espero/i.test(reply || '');
    const usuarioEnFlujoAccion = /(agendar|reservar|visita|cancelar|reprogramar|cambiar|confirmo|si\b|ok\b|dale\b)/i.test(String(message || ''))
      || Boolean(sessionMetadata?.pendingAction)
      || /PROPIEDAD_SELECCIONADA_ID:/i.test(history?.[0]?.content || '');
    const confirmacionSinAccion = isAffirmative && /(visita|reserva|turno)/i.test(String(message || ''));
    if ((pareceExitoAccion && usuarioEnFlujoAccion) || confirmacionSinAccion) {
      reply = 'Para evitar errores, prefiero confirmarlo bien antes de darte el ok final.\nSi querés, lo cerramos ahora en un paso.';
    }

    if (!reply || !String(reply).trim()) {
      reply = 'Perfecto 🙌 Decime si querés que te muestre opciones por barrio, zona o tipo de propiedad y lo vemos ahora.';
    }
  }

  // Capa final de seguridad por si algun flujo deja payload tecnico en la respuesta.
  reply = limpiarBloquesJsonInternos(reply);

  if (/^[\s{}\[\],.:;"'`_-]+$/.test(String(reply || ''))) {
    reply = 'No pude confirmar la acción en este paso. Escribime "si confirmo" y la ejecuto ahora mismo.';
  }

  if (functions.saveHistory) {
    try {
      const finalHistory = [...history, { role: "assistant", content: reply }];
      await functions.saveHistory(botId, sessionId, finalHistory, completion?.usage?.total_tokens, sessionMetadata);
      console.log(`saveHistory: Length ${finalHistory.length} for ${sessionId}`);
    } catch (err) {
      console.error("saveHistory error:", err.message);
    }
  }

  return { reply };
}

/* ================================
   HANDLER PRINCIPAL
================================ */
export const handler = async (event) => {
  const rawPath = event.rawPath || event.path || "";
  const method = event.requestContext?.http?.method || event.httpMethod || "POST";
  const qs = event.queryStringParameters || {};

  // GET: Verificación WhatsApp
  if (method === "GET" && (rawPath.includes("/whatsapp") || qs["hub.mode"])) {
    if (qs["hub.mode"] === "subscribe" && qs["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: qs["hub.challenge"] || "" };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  // Parse body (raw)
  const rawBody = getRawBody(event);
  const body = safeJsonParse(rawBody);

  // POST: Mensaje de WhatsApp (multi-tenant)
  if (method === "POST" && rawPath.includes("/whatsapp")) {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const pnid = value?.metadata?.phone_number_id;

    if (!pnid) return { statusCode: 200, body: "" };

    // Binding por PNID
    let binding = null;
    try {
      binding = await getBindingByPnid(pnid);
    } catch (err) {
      console.error(`Error leyendo binding pnid=${pnid}:`, err.message);
      return { statusCode: 200, body: "" };
    }

    if (!binding || binding.enabled !== true || !binding.botId) {
      console.log(`Binding missing/disabled for pnid=${pnid}. Ignorando.`);
      return { statusCode: 200, body: "" };
    }

    // Firma Meta (solo si hay metaAppSecret en binding)
    const signature = getHeader(event.headers || {}, "x-hub-signature-256");
    if (binding.metaAppSecret) {
      const ok = verifyMetaSignature({ rawBody, signatureHeader: signature, appSecret: binding.metaAppSecret });
      if (!ok) {
        console.log(`WhatsApp webhook: invalid signature for pnid=${pnid}`);
        return { statusCode: 403, body: "Forbidden" };
      }
    }

    const msg = value?.messages?.[0];
    if (!msg) return { statusCode: 200, body: "" };

    const userNumber = msg.from;
    const userText = msg.text?.body || "";
    const messageId = msg.id;

    // Dedup
    if (messageId) {
      try {
        const firstTime = await dedupMessageId(messageId);
        if (!firstTime) {
          console.log(`Duplicate messageId=${messageId}. Ignorando.`);
          return { statusCode: 200, body: "" };
        }
      } catch (err) {
        console.error("Dedup error:", err.message);
      }
    }

    const botId = binding.botId;

    // Chatwoot: multi-tenant inbound (por binding, con fallback a env vars)
    const cw = resolveChatwootConfig(binding);

    // Registrar incoming
    const conversationCtx = await chatwootFindOrCreateConversation(cw, userNumber);
    await chatwootSendMessage(cw, conversationCtx, userText, "incoming");

    // Silenciar bot si hay humano activo/asignado
    try {
      const convId = typeof conversationCtx === "object" ? conversationCtx.conversationId : conversationCtx;
      const assigned = await chatwootIsAssigned(cw, convId);
      const humanActive = await chatwootHasRecentHumanMessage(cw, convId);

      if (assigned || humanActive) {
        console.log(`✋ Conversación ${convId} ${assigned ? "ASIGNADA" : "CON HUMANO ACTIVO"} - bot SILENCIADO`);
        return { statusCode: 200, body: "" };
      }
    } catch (err) {
      console.error("Error verificando asignación/humano en Chatwoot:", err.message);
    }

    console.log(`✅ PNID=${pnid} → botId=${botId} → respondiendo`);

    // Procesar IA
    const { reply } = await processChat({
      botId,
      sessionId: userNumber,
      message: userText
    });

    // Resolver token (binding primero; fallback global opcional)
    const allowFallback = String(process.env.ALLOW_GLOBAL_WA_FALLBACK || "false").toLowerCase() === "true";
    const accessToken = binding.metaAccessToken || (allowFallback ? process.env.WHATSAPP_ACCESS_TOKEN : null);

    if (!accessToken) {
      console.error(`No accessToken disponible para pnid=${pnid}. (binding sin metaAccessToken y fallback desactivado)`);
      return { statusCode: 200, body: "" };
    }

    // Enviar WhatsApp (texto)
    try {
      await sendWhatsAppText({
        phoneNumberId: pnid,
        accessToken,
        to: userNumber,
        text: reply
      });
      console.log(`Reply real enviado a ${userNumber} via Meta API (status: 200)`);
      console.log(`✅ Respuesta enviada a WhatsApp ${userNumber}`);
    } catch (err) {
      console.error("Error enviando por WhatsApp:", err.message);
    }

    // Registrar outgoing en Chatwoot como bot
    await chatwootSendMessage(cw, conversationCtx, reply, "outgoing", true);

    return { statusCode: 200, body: "" };
  }

  /* ===================== CHATWOOT WEBHOOK ===================== */
  // Multi-tenant Chatwoot outbound:
  // - Rutear por cwKey = CW#<accountId>#<inboxId> usando GSI1_CWKEY
  // - Enviar WhatsApp usando metaAccessToken del binding + PNID del binding
  if (method === "POST" && rawPath.includes("/chatwoot")) {
    console.log("WEBHOOK DE CHATWOOT RECIBIDO");

    // === DEBUG: loggear payload Chatwoot (sanitizado) ===
    function redact(obj) {
      const SENSITIVE_KEYS = new Set([
        "api_access_token",
        "authorization",
        "token",
        "password",
        "access_token"
      ]);

      const seen = new WeakSet();

      function walk(x) {
        if (!x || typeof x !== "object") return x;
        if (seen.has(x)) return "[Circular]";
        seen.add(x);

        if (Array.isArray(x)) return x.map(walk);

        const out = {};
        for (const [k, v] of Object.entries(x)) {
          if (SENSITIVE_KEYS.has(String(k).toLowerCase())) out[k] = "[REDACTED]";
          else out[k] = walk(v);
        }
        return out;
      }

      return walk(obj);
    }

    console.log("CHATWOOT rawBody (first 4000 chars):", String(rawBody || "").slice(0, 4000));
    console.log("CHATWOOT parsed/redacted (first 8000 chars):", JSON.stringify(redact(body)).slice(0, 8000));

    const msg = body.message || body;
    const eventType = body.event || msg.event;
    const messageType = msg.message_type || msg.type || msg.message_type;
    const senderType = msg.sender?.type || msg.sender_type || msg.sender?.sender_type;
    const content = msg.content || msg.message || body.content || msg.body;

    if (typeof content === "string" && content.startsWith("[BOT]")) {
      console.log("⏭️  Mensaje del bot - ignorado");
      return { statusCode: 200, body: "ignored_bot" };
    }

    const isAgentMessage =
      eventType === "message_created" &&
      (messageType === "outgoing" || messageType === "outgoing_message") &&
      (senderType === "user" || senderType === "agent");

    if (isAgentMessage) {
      let phone =
        body.conversation?.meta?.sender?.phone_number ||
        body.conversation?.contact_inbox?.source_id ||
        body.source_id ||
        body.conversation?.contact?.phone_number ||
        body.conversation?.meta?.sender?.identifier ||
        msg.conversation?.contact_inbox?.source_id ||
        msg.conversation?.meta?.sender?.phone_number ||
        msg.source_id ||
        msg.contact_inbox?.source_id ||
        null;

      if (typeof phone === "string") phone = phone.replace(/^\+/, "").trim();
      const text = (content || "").replace(/^\[AGENT\]\s*/, "");

      if (!phone || !text) {
        console.log("❌ Webhook Chatwoot: falta phone o texto", { phone, text });
        return { statusCode: 200, body: "missing data" };
      }

      const accountId = body.account?.id ?? body.account_id ?? msg.account?.id ?? msg.account_id ?? null;
      const inboxId =
        body.conversation?.inbox_id ??
        body.inbox?.id ??
        body.conversation?.contact_inbox?.inbox_id ??
        msg.conversation?.inbox_id ??
        msg.inbox?.id ??
        null;

      if (!accountId || !inboxId) {
        console.error("❌ Chatwoot webhook: faltan accountId/inboxId para rutear", { accountId, inboxId });
        return { statusCode: 200, body: "missing_account_or_inbox" };
      }

      const cwKey = `CW#${accountId}#${inboxId}`;
      let binding = null;

      try {
        binding = await getBindingByCwKey(cwKey);
      } catch (err) {
        console.error(`❌ Error buscando binding por cwKey=${cwKey}:`, err.message);
        return { statusCode: 200, body: "binding_lookup_error" };
      }

      if (!binding || binding.enabled !== true) {
        console.error(`❌ No hay binding enabled para cwKey=${cwKey}.`);
        return { statusCode: 200, body: "binding_not_found" };
      }

      const pnid = parsePnidFromBinding(binding);
      if (!pnid) {
        console.error(`❌ Binding encontrado pero sin pnid (PK=${binding?.PK}).`);
        return { statusCode: 200, body: "binding_missing_pnid" };
      }

      const accessToken = binding.metaAccessToken;
      if (!accessToken) {
        console.error(`❌ Binding pnid=${pnid} no tiene metaAccessToken.`);
        return { statusCode: 200, body: "binding_missing_access_token" };
      }

      try {
        await sendWhatsAppText({
          phoneNumberId: pnid,
          accessToken,
          to: phone,
          text
        });
        console.log(`✅ Mensaje de agente enviado a WhatsApp ${phone} usando pnid=${pnid} (cwKey=${cwKey})`);
        return { statusCode: 200, body: "sent" };
      } catch (err) {
        console.error("❌ Error enviando a WhatsApp:", err.message);
        return { statusCode: 500, body: "error" };
      }
    }

    console.log("⏭️  Evento ignorado (no es mensaje de agente)");
    return { statusCode: 200, body: "ignored" };
  }

  // POST: Ruta web /chat
  if (method === "POST" && rawPath.includes("/chat")) {
    const botId = body.botId || process.env.DEFAULT_BOT_ID || "demo";
    const sessionId = body.sessionId;
    const userMessage = body.message;

    if (!userMessage) {
      return { statusCode: 400, body: JSON.stringify({ error: "Falta mensaje" }) };
    }

    const { reply } = await processChat({ botId, sessionId, message: userMessage });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify({ reply })
    };
  }

  return { statusCode: 400, body: "Ruta no válida" };
};