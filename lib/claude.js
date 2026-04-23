import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_RAPIDO = 'claude-haiku-4-5';
const MODEL_CHAT = 'claude-haiku-4-5';

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

const TOOLS = [
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

export async function briefingMatutino(eventosHoy) {
  const prompt = `Son las 8:30 AM en Mendoza. Estos son los eventos de hoy en el Calendar de Juan:

${eventosHoy}

Armale un briefing matutino:
1. Saludo breve.
2. Si hay pocos eventos (1-3): lista cada uno con una acción sugerida concreta.
3. Si hay muchos (4+): priorizá los 3 más importantes y mencioná que el resto está ahí.
4. Si hay algún seguimiento de lead, preguntá si quiere que le prepare algo.
5. Terminá con una frase motivadora corta, sin ser cursi.`;

  return callClaude(prompt);
}

export async function briefingMediodia(eventosRestantes) {
  const prompt = `Son las 14:00 hs en Mendoza. Juan ya hizo parte del día. Le quedan estos eventos:

${eventosRestantes}

Armale un check rápido:
1. Saludo breve.
2. Lista los pendientes de la tarde, priorizados.
3. Si hay un seguimiento que no hizo, marcalo como alerta.
4. Cortito, no más de 600 caracteres.`;

  return callClaude(prompt);
}

export async function briefingCierre(eventosManiana) {
  const prompt = `Son las 19:00 hs en Mendoza. Cerramos el día. Eventos agendados para MAÑANA:

${eventosManiana}

Armale un cierre:
1. Saludo corto.
2. Preview de mañana - qué es lo primero que va a enfrentar.
3. Si mañana hay algo que requiere prep hoy, mencionalo.
4. Una pregunta abierta sobre algún lead.`;

  return callClaude(prompt);
}

/**
 * Chat con tool use. Recibe el mensaje del usuario y el historial,
 * ejecuta el loop de tools internamente, y devuelve el texto final.
 * El ejecutorTools es una función async que recibe (nombre, input) y devuelve string.
 */
export async function chatLibre(mensajeDeJuan, historial = [], ejecutorTools) {
  const systemPrompt = `${CONTEXTO_BASE}

Fecha y hora actual: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })} (Mendoza).

Tenés herramientas para ver y crear eventos en el calendar. Usalas proactivamente cuando tenga sentido.`;

  let messages = [...historial, { role: 'user', content: mensajeDeJuan }];

  let response = await client.messages.create({
    model: MODEL_CHAT,
    max_tokens: 1024,
    system: systemPrompt,
    tools: TOOLS,
    messages,
  });

  // Loop de tool use - todo dentro de claude.js para evitar imports circulares
  let iteraciones = 0;
  while (response.stop_reason === 'tool_use' && iteraciones < 5) {
    iteraciones++;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const tu of toolUses) {
      let resultado;
      try {
        resultado = await ejecutorTools(tu.name, tu.input);
      } catch (err) {
        resultado = `Error ejecutando ${tu.name}: ${err.message}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: String(resultado),
      });
    }

    // Agregar turno del asistente y resultados al historial de mensajes
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];

    // Nueva llamada con el historial completo
    response = await client.messages.create({
      model: MODEL_CHAT,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });
  }

  // Extraer texto final
  const texto = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n') || 'Listo.';

  // Devolver también los mensajes finales para guardar en historial
  const mensajesFinales = [
    ...messages,
    { role: 'assistant', content: texto },
  ];

  return { texto, mensajesFinales };
}

async function callClaude(prompt) {
  const response = await client.messages.create({
    model: MODEL_RAPIDO,
    max_tokens: 1024,
    system: CONTEXTO_BASE,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
