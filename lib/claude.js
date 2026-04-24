// lib/claude.js
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5';

// ============================================================
// Tools expuestas al bot
// ============================================================

const TOOLS = [
  {
    name: 'crear_evento',
    description: 'Crea un evento en la Agenda Goldstein de Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        fecha_hora_inicio: { type: 'string', description: 'ISO 8601 con timezone AR, ej: 2026-04-24T10:00:00-03:00' },
        duracion_minutos: { type: 'number', description: 'Default 15' },
        descripcion: { type: 'string' },
      },
      required: ['titulo', 'fecha_hora_inicio'],
    },
  },
  {
    name: 'listar_eventos_hoy',
    description: 'Lista los eventos del calendario de hoy.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'listar_eventos_rango',
    description: 'Lista eventos del calendario en un rango de fechas.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'ISO date, ej: 2026-04-23' },
        hasta: { type: 'string', description: 'ISO date, ej: 2026-04-30' },
      },
      required: ['desde', 'hasta'],
    },
  },
  {
    name: 'guardar_lead',
    description: 'Guarda o actualiza un lead con el resumen del Asistente de Ventas.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        telefono: { type: 'string' },
        email: { type: 'string' },
        modelo_interes: { type: 'string' },
        resumen_asistente: { type: 'string', description: 'Texto completo del resumen del Asistente de Ventas' },
      },
      required: ['nombre', 'telefono', 'resumen_asistente'],
    },
  },
  {
    name: 'actualizar_lead_manual',
    description: 'Actualiza un lead con un comentario o audio de Juan.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_o_telefono: { type: 'string' },
        nota: { type: 'string' },
        nueva_probabilidad: { type: 'number' },
        nueva_objecion: { type: 'string' },
      },
      required: ['nombre_o_telefono', 'nota'],
    },
  },
  {
    name: 'listar_leads_prioritarios',
    description: 'Devuelve los leads ordenados por score (probabilidad + urgencia).',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'number' } },
    },
  },
  {
    name: 'ver_lead',
    description: 'Muestra el detalle completo de un lead específico.',
    input_schema: {
      type: 'object',
      properties: { nombre_o_telefono: { type: 'string' } },
      required: ['nombre_o_telefono'],
    },
  },
  {
    name: 'sincronizar_calendar',
    description: 'Lee los eventos del calendar y actualiza los leads cargados.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ============================================================
// Prompts
// ============================================================

const SYSTEM_PROMPT_CHAT = `Sos Jarvis, asistente personal de Juan (asesor Plan Óvalo en Ford Goldstein Mendoza).

Tu rol: ayudarlo a gestionar su pipeline de leads y agenda del día a día.

Principios:
- Respuestas cortas, directas, en rioplatense argentino. Sin relleno.
- Si Juan pega un resumen del Asistente de Ventas con nombre y teléfono, usá guardar_lead.
- Si Juan comenta un avance sobre un cliente, usá actualizar_lead_manual.
- Si Juan pregunta por su pipeline o a quién llamar, usá listar_leads_prioritarios.
- Si Juan pregunta por un cliente puntual, usá ver_lead.
- Si Juan pide "sincronizá" o querés refrescar con datos del calendar, usá sincronizar_calendar.
- Si Juan pide programar algo, usá crear_evento con timezone -03:00 (Argentina).

Contexto:
- La base de leads es SOLO los que Juan carga desde el Asistente de Ventas. No inventes leads.
- Cuando muestres leads: score, probabilidad, urgencia con razón, próxima acción con fecha.`;

const SYSTEM_PROMPT_EXTRACCION = `Sos un extractor de datos. Recibís un resumen de análisis de lead de Plan Óvalo Ford. Devolvé SOLO un JSON válido.

Campos:
- probabilidad_cierre (number 0-100): señales "muy caliente" → 75-90; "interesado con dudas" → 45-65; "frío" → 10-30; sin señal → 50
- etapa (string): "primer_contacto", "cotizacion_enviada", "en_negociacion", "suscripto", "adjudicado", "entregado"
- plan_discutido (string): ej "80/20", "50/50", "100% licitación", o null
- usado_parte_pago (string): "si", "no", "tasando", "no_mencionado"
- competencia (string): marca competidora, "ninguna", o "no_mencionado"
- objecion_principal (string max 80 chars): traba principal, o null
- proxima_accion_sugerida (string max 100 chars): próximo paso sugerido, o null

Respondé SOLO el JSON, sin markdown, sin texto adicional.`;

const SYSTEM_PROMPT_NOTA = `Extraés info de una nota corta de Juan sobre un cliente. Devolvé SOLO un JSON:
- nueva_probabilidad (number 0-100 o null)
- nueva_objecion (string o null)
- resumen_corto (string max 200 chars)

Respondé SOLO el JSON, sin markdown.`;

const SYSTEM_PROMPT_BRIEFING = `Sos Jarvis, asistente de Juan (asesor Plan Óvalo Ford Goldstein Mendoza).

Recibirás: leads prioritarios con scores, eventos del día, y leads del calendar sin procesar.

Generá un briefing corto y accionable en rioplatense. Máximo 10 líneas.
- Top 3 leads que atender hoy
- Agenda del día
- Alertas de compromisos vencidos
- Leads de calendar sin cargar (si hay)

No uses el score numérico, traducilo: "caliente", "urgente", "se está enfriando". Sin relleno.`;

// ============================================================
// Extractor de campos del resumen del Asistente
// ============================================================

async function extraerCamposDeResumen(resumen) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT_EXTRACCION,
    messages: [{ role: 'user', content: resumen }],
  });

  const texto = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const limpio = texto.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(limpio);
  } catch (err) {
    console.error('Error parseando JSON de extracción:', texto);
    return { probabilidad_cierre: 50, etapa: 'primer_contacto', plan_discutido: null, usado_parte_pago: 'no_mencionado', competencia: 'no_mencionado', objecion_principal: null, proxima_accion_sugerida: null };
  }
}

async function extraerCamposDeNota(nota) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT_NOTA,
    messages: [{ role: 'user', content: nota }],
  });

  const texto = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const limpio = texto.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(limpio);
  } catch {
    return { nueva_probabilidad: null, nueva_objecion: null, resumen_corto: nota.slice(0, 200) };
  }
}

// ============================================================
// Transcripción de audio
// ============================================================

async function transcribirAudio(base64, mediaType) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: 'Transcribí este audio al español rioplatense, tal cual se dice. Devolvé SOLO la transcripción, sin comentarios.',
          },
        ],
      },
    ],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// ============================================================
// Chat libre con loop de tool use
// ============================================================

async function chatLibre(mensajes, ejecutorTools) {
  let mensajesActuales = [...mensajes];
  const MAX_ITERACIONES = 8;

  for (let i = 0; i < MAX_ITERACIONES; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT_CHAT,
      tools: TOOLS,
      messages: mensajesActuales,
    });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || '(sin respuesta)';
    }

    if (response.stop_reason === 'tool_use') {
      mensajesActuales.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          try {
            const resultado = await ejecutorTools(block.name, block.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: typeof resultado === 'string' ? resultado : JSON.stringify(resultado, null, 2),
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error ejecutando ${block.name}: ${err.message}`,
              is_error: true,
            });
          }
        }
      }

      mensajesActuales.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return 'Llegué al límite de iteraciones sin poder responder.';
}

// ============================================================
// Briefing
// ============================================================

async function generarBriefing(payload) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT_BRIEFING,
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

module.exports = { chatLibre, generarBriefing, extraerCamposDeResumen, extraerCamposDeNota, transcribirAudio, TOOLS };
