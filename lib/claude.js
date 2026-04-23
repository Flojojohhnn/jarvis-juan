import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_RAPIDO = 'claude-haiku-4-5';
const MODEL_CHAT = 'claude-haiku-4-5'; // cambiar a 'claude-sonnet-4-5' si querés mejor razonamiento

/**
 * Contexto base que describe quién es Juan - inyectado en todos los prompts.
 * Esto es lo que hace que Claude hable como "tu asistente" y no genérico.
 */
const CONTEXTO_BASE = `Sos el asistente personal de trabajo de Juan Manuel Dominguez, asesor comercial de Plan Óvalo en Ford Goldstein, Mendoza, Argentina.

Perfil de Juan:
- ~20 años vendiendo planes de ahorro Ford
- Trabaja con Tecnom Nubux como CRM
- Maneja leads de Ranger, Territory, Maverick, Transit, Bronco
- Habla español rioplatense
- Valora respuestas directas, sin relleno, accionables

Tu rol:
- Ayudarlo a priorizar pendientes del día
- Recordarle seguimientos de leads que no hizo
- Sugerir acciones concretas (no describir lo obvio)
- Usar su tono: directo, laburante, de cancha

Estilo: máximo 800 caracteres, sin emojis excesivos, sin preámbulos, tutéalo siempre.`;

/**
 * Genera el briefing matutino.
 */
export async function briefingMatutino(eventosHoy) {
  const prompt = `Son las 8:30 AM en Mendoza. Estos son los eventos de hoy en el Calendar de Juan (vienen del Tecnom, de reuniones presenciales, y seguimientos de leads):

${eventosHoy}

Armale un briefing matutino:
1. Arranque con un saludo breve.
2. Si hay pocos eventos (1-3): lista cada uno con una acción sugerida concreta.
3. Si hay muchos (4+): priorizá los 3 más importantes y mencioná que el resto está ahí.
4. Si hay algún seguimiento de lead, preguntá si quiere que le prepare algo (pregunta abierta).
5. Terminá con una frase motivadora corta, sin ser cursi.`;

  return callClaude(prompt, MODEL_RAPIDO);
}

/**
 * Briefing del mediodía: check de avance.
 */
export async function briefingMediodia(eventosRestantes) {
  const prompt = `Son las 14:00 hs en Mendoza. Juan ya hizo parte del día. Le quedan estos eventos por delante:

${eventosRestantes}

Armale un check rápido:
1. Saludo breve ("Qué tal la mañana...", cosas así).
2. Lista los pendientes de la tarde, priorizados.
3. Si hay un seguimiento que no hizo hace días, marcalo como alerta.
4. Cortito, no más de 600 caracteres.`;

  return callClaude(prompt, MODEL_RAPIDO);
}

/**
 * Cierre del día: lo pendiente + preview de mañana.
 */
export async function briefingCierre(eventosManiana) {
  const prompt = `Son las 19:00 hs en Mendoza. Cerramos el día. Estos son los eventos agendados para MAÑANA:

${eventosManiana}

Armale un cierre:
1. Saludo corto.
2. Preview de mañana - qué es lo primero que va a enfrentar.
3. Si ves que mañana hay algo que requiere prep hoy (ej: llevar material a una reunión), mencionalo.
4. Una pregunta abierta: "¿querés que repasemos algún lead antes de mañana?" o similar.`;

  return callClaude(prompt, MODEL_RAPIDO);
}

/**
 * Chat libre - Juan le escribe algo al bot, el bot interpreta.
 * Usamos tool calling para que pueda crear eventos cuando se lo pida.
 */
export async function chatLibre(mensajeDeJuan, historial = [], contextoCalendar = '') {
  const tools = [
    {
      name: 'crear_evento',
      description: 'Crea un evento en el Google Calendar de Juan. Usalo cuando Juan pida agendar, recordar o recordarle algo en una fecha/hora específica.',
      input_schema: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título corto del evento' },
          descripcion: { type: 'string', description: 'Detalles adicionales (opcional)' },
          fecha_hora_inicio: {
            type: 'string',
            description: 'ISO 8601 en zona horaria Mendoza (ej: 2026-04-24T10:00:00-03:00)',
          },
          duracion_minutos: { type: 'number', description: 'Duración en minutos (default 30)' },
        },
        required: ['titulo', 'fecha_hora_inicio'],
      },
    },
    {
      name: 'listar_eventos_hoy',
      description: 'Devuelve los eventos del calendar de hoy. Usalo cuando Juan pregunte qué tiene hoy, qué pendientes, etc.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'listar_eventos_rango',
      description: 'Devuelve los eventos entre dos fechas. Usalo para consultas tipo "qué tengo esta semana" o "qué tengo mañana".',
      input_schema: {
        type: 'object',
        properties: {
          desde: { type: 'string', description: 'ISO 8601 fecha desde' },
          hasta: { type: 'string', description: 'ISO 8601 fecha hasta' },
        },
        required: ['desde', 'hasta'],
      },
    },
  ];

  const systemPrompt = `${CONTEXTO_BASE}

Fecha y hora actual: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })} (Mendoza).

${contextoCalendar ? `Contexto de calendar reciente:\n${contextoCalendar}\n` : ''}

Tenés herramientas para ver y crear eventos en el calendar. Usalas proactivamente cuando tenga sentido. No pidas confirmación para acciones obvias - hacelas directamente.`;

  const messages = [...historial, { role: 'user', content: mensajeDeJuan }];

  const response = await client.messages.create({
    model: MODEL_CHAT,
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    messages,
  });

  return response;
}

async function callClaude(prompt, model) {
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: CONTEXTO_BASE,
    messages: [{ role: 'user', content: prompt }],
  });
  // Extraer solo el texto de la respuesta
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  /**
 * Versión de chatLibre que acepta el array de mensajes completo directamente.
 * Usada en el loop de tool use.
 */
export async function chatLibreConMensajes(messages) {
  const tools = [
    {
      name: 'crear_evento',
      description: 'Crea un evento en el Google Calendar de Juan.',
      input_schema: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          descripcion: { type: 'string' },
          fecha_hora_inicio: { type: 'string', description: 'ISO 8601 en zona horaria Mendoza (ej: 2026-04-24T10:00:00-03:00)' },
          duracion_minutos: { type: 'number' },
        },
        required: ['titulo', 'fecha_hora_inicio'],
      },
    },
    {
      name: 'listar_eventos_hoy',
      description: 'Devuelve los eventos del calendar de hoy.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'listar_eventos_rango',
      description: 'Devuelve los eventos entre dos fechas.',
      input_schema: {
        type: 'object',
        properties: {
          desde: { type: 'string' },
          hasta: { type: 'string' },
        },
        required: ['desde', 'hasta'],
      },
    },
  ];

  const response = await client.messages.create({
    model: MODEL_CHAT,
    max_tokens: 1024,
    system: CONTEXTO_BASE,
    tools,
    messages,
  });

  return response;
}
}
