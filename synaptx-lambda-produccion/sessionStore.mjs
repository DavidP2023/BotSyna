// sessionStore.mjs — DynamoDB session store with TTL support.
// Reads/writes the same table as functions.mjs (SESSIONS_TABLE) for full compatibility.
// Key schema: PK = SESSION#<tenantId>, SK = <userId>

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const doc    = DynamoDBDocumentClient.from(client);

const TABLE           = process.env.SESSIONS_TABLE;
const DEFAULT_TTL_DAYS = 30;

/**
 * Loads a session from DynamoDB.
 * Returns { history, ctx, tokensUsed }.
 * Compatible with the old { history, metadata } shape — merges both.
 */
export async function loadSession(tenantId, userId) {
  const empty = { history: [], ctx: {}, tokensUsed: 0 };
  if (!TABLE) return empty;

  try {
    const res = await doc.send(new GetCommand({
      TableName:     TABLE,
      Key:           { PK: `SESSION#${tenantId}`, SK: userId },
      ConsistentRead: true
    }));

    if (!res.Item) return empty;

    return {
      history:    res.Item.history    || [],
      ctx:        res.Item.ctx        || res.Item.metadata || {},
      tokensUsed: res.Item.tokensUsed || 0
    };
  } catch (err) {
    console.error('sessionStore.loadSession error:', err.message);
    return empty;
  }
}

/**
 * Persists a session to DynamoDB.
 * Writes both `ctx` and `metadata` (backward-compatible alias).
 * Sets a DynamoDB TTL so idle sessions are auto-deleted.
 */
export async function saveSession(tenantId, userId, history, ctx, tokensUsed = 0, ttlDays = DEFAULT_TTL_DAYS) {
  if (!TABLE) return;

  const now = Math.floor(Date.now() / 1000);
  const ttl = now + ttlDays * 24 * 60 * 60;

  const stamped = history.map(m => ({
    ...m,
    timestamp: m.timestamp || new Date().toISOString()
  }));

  try {
    await doc.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK:         `SESSION#${tenantId}`,
        SK:         userId,
        history:    stamped,
        ctx,
        metadata:   ctx,      // backward-compat alias read by functions.mjs
        tokensUsed,
        updatedAt:  new Date().toISOString(),
        ttl                   // DynamoDB auto-deletes after ttlDays of inactivity
      }
    }));
  } catch (err) {
    console.error('sessionStore.saveSession error:', err.message);
  }
}

/**
 * Trims history to a sliding window.
 * Always keeps system prompt at index 0, then the most recent `maxMessages` turns.
 */
export function trimHistory(history, maxMessages = 30) {
  if (!Array.isArray(history) || history.length <= maxMessages + 1) return history;

  const system = history[0]?.role === 'system' ? [history[0]] : [];
  const rest   = history.slice(system.length);
  return [...system, ...rest.slice(-maxMessages)];
}
