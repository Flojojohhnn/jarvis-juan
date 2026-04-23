import { Redis } from '@upstash/redis';
import { chatLibre } from '../lib/claude.js';
import { sendMessage, isAuthorizedUser } from '../lib/telegram.js';
import { listEvents, createEvent, formatEventsForPrompt } from '../lib/calendar.js';

const redis = Redis.fromEnv();
const MAX_HISTORIAL = 10; // últimos 10 turnos

/**
 * Webhook de Telegram. Recibe mensajes, los procesa con Claude (con tool use
 * para crear/listar eventos), y responde.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Seguridad: Telegram nos manda un secret token en el header
  const telegramSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (telegramSecret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const update = req.body;
  const message = update.message;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text;

  // Solo responde al usuario autorizado
  if (!isAuthorizedUser(userId)) {
    return res.status(200).json({ ok: true });
  }

  try {
    // Recuperar historial de Redis
    const historialKey = `jarvis:historial:${userId}`;
    const historial = (await redis.get(historialKey)) || [];

    // Llamar a Claude con tool use
    let response = await chatLibre(text, historial);

    // Loop de tool use - Claude puede querer llamar varias tools
    let iteraciones = 0;
    while (response.stop_reason === 'tool_use' && iteraciones < 5) {
      iteraciones++;
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];

      for (const tu of toolUses) {
        const resultado = await ejecutarTool(tu.name, tu.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultado,
        });
      }

      // Segunda llamada a Claude con los resultados de las tools
      const mensajesActualizados = [
        ...historial,
        { role: 'user', content: text },
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];

      response = await chatLibre('', mensajesActualizados.slice(0, -1), '');
    }

    // Extraer respuesta final en texto
    const respuestaTexto = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n') || 'Listo.';

    // Guardar historial actualizado (solo texto, no tool uses)
    const nuevoHistorial = [
      ...historial,
      { role: 'user', content: text },
      { role: 'assistant', content: respuestaTexto },
    ].slice(-MAX_HISTORIAL * 2);

    await redis.set(historialKey, nuevoHistorial, { ex: 60 * 60 * 24 * 7 });

    await sendMessage(chatId, respuestaTexto);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error en telegram handler:', error);
    await sendMessage(chatId, `Ups, algo falló: ${error.message}`);
    return res.status(200).json({ ok: true });
  }
}

/**
 * Ejecuta una tool que Claude pidió.
 */
async function ejecutarTool(nombre, input) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (nombre === 'crear_evento') {
    const duracion = input.duracion_minutos || 30;
    const inicio = new Date(input.fecha_hora_inicio);
    const fin = new Date(inicio.getTime() + duracion * 60 * 1000);
    const evento = await createEvent({
      calendarId,
      summary: input.titulo,
      description: input.descripcion || '',
      start: inicio.toISOString(),
      end: fin.toISOString(),
    });
    return `Evento creado: "${evento.summary}" el ${inicio.toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}.`;
  }

  if (nombre === 'listar_eventos_hoy') {
    const now = new Date();
    const fin = new Date(now);
    fin.setHours(23, 59, 59, 999);
    const eventos = await listEvents({ calendarId, timeMin: now, timeMax: fin });
    return formatEventsForPrompt(eventos);
  }

  if (nombre === 'listar_eventos_rango') {
    const eventos = await listEvents({
      calendarId,
      timeMin: new Date(input.desde),
      timeMax: new Date(input.hasta),
    });
    return formatEventsForPrompt(eventos);
  }

  return `Tool "${nombre}" no reconocida.`;
}
