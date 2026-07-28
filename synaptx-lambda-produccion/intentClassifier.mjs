// intentClassifier.mjs — Classifies user intent without AI when possible.
// Rule: classify with patterns first (cheap), only return 'needs_ai' when nothing matches.

import { buildStructuredIntent } from './services/intentSchema.mjs';

const PATTERNS = {
  greeting:    [/^(hola|buenas|buen\s*d[ií]a|buenos\s*d[ií]as|hey|hi|buenas\s*tardes|buenas\s*noches)\b/i],
  search:      [/buscar|quiero\s*ver|mostr[aá]|ten[eé]s\s*(algo|propiedades|departamentos|casas)|hay\s*.*(disponible|en\s*venta|en\s*alquiler)|busco\s*(depto|departamento|casa|local|ph|duplex|terreno|oficina)|ver\s*(propiedades|departamentos|casas|opciones)/i],
  book:        [/reservar|agendar|sacar\s*turno|quiero\s*(visitar|ver\s*el|ir\s*a|coordinar)|hacer\s*(una\s*)?visita|visita\s*para|quiero\s*un\s*turno|necesito\s*turno/i],
  cancel:      [/cancelar\s*(visita|turno|reserva)|anular\s*(visita|turno)|no\s*(voy|puedo\s*ir)\s*(a\s*la)?\s*(visita|turno)|borr[aá]\s*(la\s*)?(visita|turno)/i],
  reschedule:  [/cambiar\s*(la\s*)?(visita|turno|horario|fecha|hora)|reprogramar\s*(la\s*)?(visita|turno)|mover\s*(la\s*)?(visita|turno)|otro\s*d[ií]a\s*(para\s*(la\s*)?(visita|turno))?/i],
  status:      [/mis\s*(visitas|turnos|reservas)|qu[eé]\s*(visitas|turnos)\s*tengo|tengo\s*(visita|turno)\s*(agendad[ao])?|visita\s*agendada|ver\s*mis\s*(visitas|turnos)/i],
  confirm:     [/^(si|sí|s|dale|ok|okay|confirmo|confirmado|de\s*una|perfecto|listo|hag[aá]moslo|hacelo|procede|proceda|claro|va|sale|bueno|exacto)\s*[.!?]?$/i],
  deny:        [/^(no|nel|para\s*nada|mejor\s*no|cancel[ao]|no\s*gracias)\s*[.!?]?$/i],
  escalate:    [/hablar\s*(con\s*)?(una\s*)?(persona|alguien|humano|agente|asesor|encargado)|quiero\s*hablar\s*(con\s*alguien)?|necesito\s*(ayuda\s*)?humana?|comunicarme\s*con/i],
  thanks:      [/^(gracias|muchas\s*gracias|mil\s*gracias)\s*[.!]?$|bu[eé]n[ií]simo.*gracias|genial.*gracias/i],
  more:        [/m[aá]s\s*(opciones|propiedades|resultados|turnos)|ver\s*m[aá]s|otras\s*(opciones|propiedades)|siguiente(s)?|sigui[eé]nte/i],
  details:     [/m[aá]s\s*(informaci[oó]n|info|detalles)|cu[aá]nto\s*(sale|cuesta|vale|es\s*el\s*precio)|precio|descripci[oó]n|caracter[ií]sticas|qu[eé]\s*incluye|metros/i],
};

/**
 * Classifies a user message into an intent.
 *
 * @param {string} message - Raw user message
 * @param {{ intent: string, confidence: number } | null} pluginResult - Optional plugin classification
 * @returns {{ intent: string, confidence: number, source: string }}
 */
export function classifyIntent(message, pluginResult = null) {
  if (pluginResult?.confidence >= 0.85) {
    return {
      ...pluginResult,
      source: 'plugin',
      structured: pluginResult?.structured
        || buildStructuredIntent({
          intent: pluginResult?.intent || 'unknown',
          message,
          source: 'plugin',
          confidence: pluginResult?.confidence || 0.85,
        }),
    };
  }

  const msg = String(message || '').trim();

  for (const [intent, patterns] of Object.entries(PATTERNS)) {
    if (patterns.some(p => p.test(msg))) {
      return {
        intent,
        confidence: 0.80,
        source: 'pattern',
        structured: buildStructuredIntent({ intent, message, source: 'pattern', confidence: 0.80 }),
      };
    }
  }

  return {
    intent: 'unknown',
    confidence: 0,
    source: 'needs_ai',
    structured: buildStructuredIntent({ intent: 'unknown', message, source: 'needs_ai', confidence: 0 }),
  };
}
