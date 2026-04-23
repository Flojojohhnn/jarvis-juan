// lib/claude.js
// Cliente Anthropic, prompts del sistema, extracción de campos del Asistente, y loop de tool use

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5';

// ============================================================
// Definición de tools expuestas al bot
// ============================================================

export const TOOLS = [
  {
    name: 'crear_evento',
    description:
      'Crea un evento en la Agenda Goldstein de Google Calendar. Usar cuando Juan pide programar una acción, recordatorio o seguimiento.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título corto del evento' },
        fecha_hora_inicio: {
          type: 'string',
          description: 'ISO 8601 con timezone AR, ej: 2026-04-24T10:00:00-03:00',
        },
        duracion_minutos: { type: 'number', description: 'Duración en minutos, default 15' },
        descripcion: { type: 'string', description: 'Detalle del evento (opcional)' },
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
    description:
      'Guarda o actualiza un lead en la base. Se usa cuando Juan pega el resumen que le dio el Asistente de Ventas + el nombre y teléfono del cliente. La tool extrae automáticamente los metadatos estructurados del resumen.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del cliente' },
        telefono: { type: 'string', description: 'Teléfono, puede venir con +54 o sin' },
        email: { type: 'string', description: 'Email si está disponible (opcional)' },
        modelo_interes: {
          type: 'string',
          description: 'Modelo Ford de interés (Ranger, Territory, Bronco, etc.)',
        },
        resumen_asistente: {
          type: 'string',
          description: 'Texto completo del resumen que dio el Asistente de Ventas',
        },
      },
      required: ['nombre', 'telefono', 'resumen_asistente'],
    },
  },
  {
    name: 'actualizar_lead_manual',
    description:
      'Actualiza un lead con un comentario manual de Juan (típicamente viene de un audio). Suma la nota al historial y permite ajustar probabilidad de cierre u objeción principal si el texto lo indica.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_o_telefono: {
          type: 'string',
          description: 'Nombre parcial o teléfono para identificar al lead',
        },
        nota: { type: 'string', description: 'El comentario/avance que Juan quiere registrar' },
        nueva_probabilidad: {
          type: 'number',
          description: 'Opcional: nueva probabilidad de cierre (0-100) si el comentario la cambia',
        },
        nueva_objecion: {
          type: 'string',
          description: 'Opcional: objeción principal actualizada si cambió',
        },
      },
      required: ['nombre_o_telefono', 'nota'],
    },
  },
  {
    name: 'listar_leads_prioritarios',
    description:
      'Devuelve los leads ordenados por score (probabilidad + urgencia). Usar cuando Juan pregunta por su pipeline o qué leads atender.',
    input_schema: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Cantidad máxima, default 10' },
      },
    },
  },
  {
    name: 'ver_lead',
    description: 'Muestra el detalle completo de un lead específico.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_o_telefono: { type: 'string' },
      },
      required: ['nombre_o_telefono'],
    },
  },
  {
    name: 'sincronizar_calendar',
    description:
      'Lee los eventos recientes y próximos del calendar y actualiza los leads cargados con las gestiones hechas y próximas acciones. Retorna qué leads se actualizaron y qué eventos no matchearon ningún lead cargado.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ============================================================
// Prompt de sistema del bot (chat general)
// ============================================================

const SYSTEM_PROMPT_CHAT = `Sos Jarvis, asistente personal de Juan (asesor Plan Óvalo en Ford Goldstein Mendoza).

Tu rol: ayudarlo a gestionar su pipeline de leads y agenda del día a día.

Principios:
- Respuestas cortas, directas, en rioplatense argentino. Sin relleno, sin emojis salvo cuando aporten.
- Si Juan te pide programar algo, usá crear_evento con timezone -03:00 (Argentina).
- Si Juan pega un resumen del Asistente de Ventas con nombre y teléfono, usá guardar_lead.
- Si Juan te comenta un avance sobre un cliente (típicamente por audio transcripto), usá actualizar_lead_manual.
- Si Juan pregunta por sus leads, por su pipeline, o a quién llamar, usá listar_leads_prioritarios.
- Si Juan pregunta por un cliente puntual, usá ver_lead.
- Si Juan pide "sincronizá" o querés refrescar con datos del calendar, usá sincronizar_calendar.

Contexto clave:
- Juan trabaja con Tecnom CRM que vuelca automáticamente los eventos de gestión al calendar.
- La base de leads es SOLO los que Juan carga desde el Asistente de Ventas. No inventes leads.
- Cuando muestres leads, prioridad visual: score, probabilidad de cierre, urgencia con razón, próxima acción con fecha.`;

// ============================================================
// Prompt para extraer metadatos del resumen del Asistente de Ventas
// ============================================================

const SYSTEM_PROMPT_EXTRACCION = `Sos un extractor de datos. Recibís un resumen de análisis de lead que hizo un Asistente de Ventas de Plan Óvalo Ford. Tu trabajo: devolver SOLO un JSON válido con los campos estructurados que encuentres.

Campos a extraer:
- probabilidad_cierre (number 0-100): inferí del tono del análisis. Señales: "muy caliente"/"cerca de cerrar" → 75-90; "interesado pero con dudas" → 45-65; "frío" → 10-30. Si no hay señal clara, usá 50.
- etapa (string, uno de): "primer_contacto", "cotizacion_enviada", "en_negociacion", "suscripto", "adjudicado", "entregado"
- plan_discutido (string): ej "80/20", "50/50", "100% licitación", o null si no se menciona
- usado_parte_pago (string, uno de): "si", "no", "tasando", "no_mencionado"
- competencia (string): marca que aparece como competencia, o "ninguna", o "no_mencionado"
- objecion_principal (string): resumen en menos de 80 caracteres de la traba principal si hay, o null
- proxima_accion_sugerida (string): la acción que el análisis sugiere como próximo paso, resumida en menos de 100 caracteres

Respondé SOLO el JSON, sin markdown, sin comentarios, sin texto adicional.`;

// ============================================================
// Extractor de campos desde resumen de Asistente
// ============================================================

export async function extraerCamposDeResumen(resumen) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT_EXTRACCION,
    messages: [{ role: 'user', content: resumen }],
  });

  const texto = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Limpiar por si viene con fences
  const limpio = texto.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(limpio);
  } catch (err) {
    console.error('Error parseando JSON de extracción:', texto);
    return {
      probabilidad_cierre: 50,
      etapa: 'primer_contacto',
      plan_discutido: null,
      usado_parte_pago: 'no_mencionado',
      competencia: 'no_mencionado',
      objecion_principal: null,
      proxima_accion_sugerida: null,
    };
  }
}

// ============================================================
// Extractor liviano para audio/nota manual
// ============================================================

const SYSTEM_PROMPT_NOTA = `Extraés información de una nota corta que Juan dejó sobre un cliente. Devolvé SOLO un JSON con:
- nueva_probabilidad (number 0-100 o null): si la nota sugiere que la probabilidad cambió
- nueva_objecion (string o null): si aparece una objeción nueva o cambió la principal
- resumen_corto (string max 200 chars): lo más importante de la nota

Respondé SOLO el JSON, sin markdown.`;

export async function extraerCamposDeNota(nota) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT_NOTA,
    messages: [{ role: 'user', content: nota }],
  });

  const texto = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const limpio = texto.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(limpio);
  } catch (err) {
    return { nueva_probabilidad: null, nueva_objecion: null, resumen_corto: nota.slice(0, 200) };
  }
}

// ============================================================
// Chat libre con loop de tool use
// ============================================================

/**
 * @param {Array} mensajes - historial de mensajes formato Anthropic
 * @param {Function} ejecutorTools - async (toolName, toolInput) => any
 * @returns {Promise<string>} respuesta final en texto
 */
export async function chatLibre(mensajes, ejecutorTools) {
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

    // Si el modelo terminó sin usar tools, devolvemos el texto
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      const texto = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return texto || '(sin respuesta)';
    }

    // Si pidió tool_use, ejecutamos cada uno
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
              content:
                typeof resultado === 'string' ? resultado : JSON.stringify(resultado, null, 2),
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

    // Cualquier otro stop_reason: salimos
    break;
  }

  return 'Llegué al límite de iteraciones sin poder responder.';
}

// ============================================================
// Generación de briefing (sin tool use, solo síntesis)
// ============================================================

const SYSTEM_PROMPT_BRIEFING = `Sos Jarvis, asistente de Juan (asesor Plan Óvalo Ford Goldstein Mendoza).

Vas a recibir:
1. Los leads prioritarios con sus scores y urgencias
2. Los eventos del calendar del período relevante
3. Leads en calendar que no están en la base (para que Juan los procese manualmente)

Generá un briefing corto y accionable en rioplatense. Estructura:
- Qué atender HOY con prioridad (top 3 leads)
- Qué agendas tiene programadas
- Alertas de compromisos vencidos
- Leads de calendar sin procesar (si hay)

Reglas:
- Máximo 10 líneas. Sin relleno.
- Si no hay nada urgente, decilo corto.
- No repitas el score textual, traducilo a lenguaje natural ("caliente", "urgente", "se está enfriando").`;

export async function generarBriefing(payload) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT_BRIEFING,
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
