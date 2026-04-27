import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});
const MODEL = 'claude-haiku-4-5';

// ============================================================
// Tools expuestas al bot (13 tools)
// ============================================================

export const TOOLS = [
  {
    name: 'crear_evento',
    description: 'Crea un evento en Google Calendar. Antes de crear, si el usuario no especificó hora exacta o mencionó un nombre que puede tener evento previo hoy, usá listar_eventos_hoy para verificar duplicados.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        fecha_hora_inicio: { type: 'string', description: 'ISO 8601 con timezone AR. Ej: 2026-04-24T10:00:00-03:00' },
        duracion_minutos: { type: 'number', description: 'Default 60' },
        descripcion: { type: 'string' },
      },
      required: ['titulo', 'fecha_hora_inicio'],
    },
  },
  {
    name: 'listar_eventos_hoy',
    description: 'Lista los eventos del calendario de hoy. La respuesta incluye el id de cada evento, necesario para eliminar o modificar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'listar_eventos_rango',
    description: 'Lista eventos del calendario en un rango de fechas. La respuesta incluye el id de cada evento.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'ISO 8601 datetime con timezone AR. Ej: 2026-04-25T00:00:00-03:00' },
        hasta: { type: 'string', description: 'ISO 8601 datetime con timezone AR. Ej: 2026-04-25T23:59:59-03:00' },
      },
      required: ['desde', 'hasta'],
    },
  },
  {
    name: 'eliminar_evento',
    description: 'Elimina un evento del calendario. Primero usá listar_eventos_hoy o listar_eventos_rango para obtener el id del evento.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID del evento de Google Calendar (viene del listado)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'actualizar_evento',
    description: 'Modifica el título, descripción, hora o duración de un evento existente. Primero obtenés el id con listar_eventos_hoy.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        nuevo_titulo: { type: 'string' },
        nueva_descripcion: { type: 'string' },
        nueva_fecha_hora_inicio: { type: 'string', description: 'ISO 8601 con timezone AR' },
        nueva_duracion_minutos: { type: 'number' },
      },
      required: ['event_id'],
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
    description: 'Lee los eventos del calendar con formato Tecnom y actualiza los leads cargados. Usá solo si Juan lo pide explícitamente.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'guardar_memoria',
    description: 'Guarda una preferencia o instrucción permanente. Usá cuando Juan diga "recordá", "a partir de ahora", "siempre" o "para siempre".',
    input_schema: {
      type: 'object',
      properties: {
        contenido: { type: 'string', description: 'La instrucción o preferencia a recordar permanentemente' },
      },
      required: ['contenido'],
    },
  },
  {
    name: 'ver_memoria',
    description: 'Muestra todas las preferencias e instrucciones permanentes guardadas.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'borrar_memoria',
    description: 'Elimina una entrada de memoria por su número (obtenelo con ver_memoria).',
    input_schema: {
      type: 'object',
      properties: {
        indice: { type: 'number', description: 'Número de entrada (1 = más reciente)' },
      },
      required: ['indice'],
    },
  },
];

// ============================================================
// System prompts
// ============================================================

function getSYSTEM_CHAT() {
  const ahora = new Date();
  const fechaAR = ahora.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Mendoza',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `Hoy es ${fechaAR}. Sos Jarvis, asistente personal de Juan (asesor Plan Óvalo en Ford Goldstein Mendoza).

Tu rol: ayudarlo a gestionar su pipeline de leads y agenda del día a día.

Principios:
- Respuestas cortas, directas, en rioplatense argentino. Sin relleno.
- Si Juan pega un resumen del Asistente de Ventas con nombre y teléfono, usá guardar_lead.
- Si Juan comenta un avance sobre un cliente, usá actualizar_lead_manual.
- Si Juan pregunta por su pipeline o a quién llamar, usá listar_leads_prioritarios.
- Si Juan pregunta por un cliente puntual, usá ver_lead.
- Usá sincronizar_calendar solo si Juan lo pide explícitamente. No lo uses para resolver problemas de datos.
- Si Juan pide programar algo, usá crear_evento con timezone -03:00 (Argentina) y confirmá hora de inicio y fin.
- Antes de crear un evento, si Juan no especificó hora exacta o mencionó un nombre que podría tener evento previo hoy, usá listar_eventos_hoy para verificar.
- Para borrar un evento: listá primero con listar_eventos_hoy para obtener el id, luego eliminar_evento.
- Para modificar un evento: igual, listá primero y usá actualizar_evento.
- Si Juan dice "recordá", "a partir de ahora", "siempre" o "para siempre", usá guardar_memoria.
- Si Juan pregunta qué recordás o quiere ver sus preferencias, usá ver_memoria.

Contexto:
- La base de leads es SOLO los que Juan carga desde el Asistente de Ventas. No inventes leads.
- Cuando muestres leads: score, probabilidad, urgencia con razón, próxima acción con fecha.
- La duración por defecto de eventos es 60 minutos, no 15.`;
}

const SYSTEM_EXTRACCION = `Sos un extractor de datos. Recibís un resumen de análisis de lead de Plan Óvalo Ford. Devolvé SOLO un JSON válido.

Campos:
- probabilidad_cierre (number 0-100): señales "muy caliente" → 75-90; "interesado con dudas" → 45-65; "frío" → 10-30; sin señal → 50
- etapa (string): "primer_contacto", "cotizacion_enviada", "en_negociacion", "suscripto", "adjudicado", "entregado"
- plan_discutido (string): ej "80/20", "50/50", "100% licitación", o null
- usado_parte_pago (string): "si", "no", "tasando", "no_mencionado"
- competencia (string): marca competidora, "ninguna", o "no_mencionado"
- objecion_principal (string max 80 chars): traba principal, o null
- proxima_accion_sugerida (string max 100 chars): próximo paso sugerido, o null
- proxima_accion_fecha (string "YYYY-MM-DD" o null): solo si se menciona una fecha concreta (ej "llamar el 26/04" → "2026-04-26"); si dice "la semana que viene" o es vago → null

Respondé SOLO el JSON, sin markdown, sin texto adicional.`;

const SYSTEM_NOTA = `Extraés info de una nota corta de Juan sobre un cliente. Devolvé SOLO un JSON:
- nueva_probabilidad (number 0-100 o null)
- nueva_objecion (string o null)
- resumen_corto (string max 200 chars)

Respondé SOLO el JSON, sin markdown.`;

const SYSTEM_BRIEFING = `Sos Jarvis, asistente de Juan (asesor Plan Óvalo Ford Goldstein Mendoza).

Recibirás un JSON con: leads prioritarios con scores, eventos del día, y leads del calendar sin procesar.

Generá un briefing corto y accionable en rioplatense. Máximo 10 líneas.
- Top 3 leads que atender hoy
- Agenda del día
- Alertas de compromisos vencidos

IMPORTANTE: Usá SOLO los datos del JSON. No inferés tiempo transcurrido, historial ni contexto que no esté presente. Si un campo es null o falta, omitilo directamente. Si urgencia_razon dice algo sobre días de contacto pero ultima_gestion_fecha es null, ignorá ese dato y tratá el lead como nuevo. No menciones cantidad de días sin contacto si ultima_gestion_fecha es null o si el valor supera los 365 días — en ese caso decí "lead nuevo" solamente. No uses el score numérico, traducilo: "caliente", "urgente", "se está enfriando". Sin relleno.`;

// ============================================================
// Helpers
// ============================================================

function parsearJSON(texto, fallback) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(limpio);
  } catch {
    return fallback;
  }
}

// ============================================================
// Funciones exportadas
// ============================================================

export async function extraerCamposDeResumen(resumen) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_EXTRACCION,
    messages: [{ role: 'user', content: resumen }],
  });
  const texto = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parsearJSON(texto, {
    probabilidad_cierre: 50, etapa: 'primer_contacto', plan_discutido: null,
    usado_parte_pago: 'no_mencionado', competencia: 'no_mencionado',
    objecion_principal: null, proxima_accion_sugerida: null, proxima_accion_fecha: null,
  });
}

export async function extraerCamposDeNota(nota) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_NOTA,
    messages: [{ role: 'user', content: nota }],
  });
  const texto = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parsearJSON(texto, { nueva_probabilidad: null, nueva_objecion: null, resumen_corto: nota.slice(0, 200) });
}

export async function transcribirAudio(base64, mediaType) {
  const buffer = Buffer.from(base64, 'base64');
  const file = await toFile(buffer, 'audio.ogg', { type: mediaType });
  const transcripcion = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    language: 'es',
  });
  return transcripcion.text;
}

// memoria: string de texto con las preferencias del usuario, se inyecta en el system prompt
export async function chatLibre(mensajes, ejecutorTools, memoria = '') {
  let mensajesActuales = [...mensajes];
  const MAX_ITER = 8;

  const baseSystem = getSYSTEM_CHAT();
  const system = memoria
    ? `${baseSystem}\n\n## Instrucciones permanentes de Juan:\n${memoria}`
    : baseSystem;

  for (let i = 0; i < MAX_ITER; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
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
        if (block.type !== 'tool_use') continue;
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
      mensajesActuales.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return 'Llegué al límite de iteraciones sin poder responder.';
}

export async function generarBriefing(payload) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_BRIEFING,
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
