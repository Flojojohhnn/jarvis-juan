import { Redis } from '@upstash/redis';
import { chatLibre } from '../lib/claude.js';
import { sendMessage, isAuthorizedUser } from '../lib/telegram.js';
import { listEvents, createEvent, formatEventsForPrompt } from '../lib/calendar.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_HISTORIAL = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  if (!isAuthorizedUser(userId)) {
    return res.status(200).json({ ok: true });
  }

  try {
    // Recuperar historial de Redis
    const historialKey = `jarvis:historial:${userId}`;
    let historial = [];
    try {
      historial = (await redis.get(historialKey)) || [];
    } catch (_) {
      historial = [];
    }

    // Ejecutor de tools - se lo pasamos a claude.js
    const ejecutorTools = async (nombre, input) => {
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
    };

    // Llamar a Claude con tool use integrado
    const { texto, mensajesFinales } = await chatLibre(text, historial, ejecutorTools);

    // Guardar historial actualizado (solo los últimos MAX_HISTORIAL turnos)
    const nuevoHistorial = mensajesFinales.slice(-(MAX_HISTORIAL * 2));
    try {
      await redis.set(historialKey, nuevoHistorial, { ex: 60 * 60 * 24 * 7 });
    } catch (_) {}

    await sendMessage(chatId, texto);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error en telegram handler:', error);
    await sendMessage(chatId, `Ups, algo falló: ${error.message}`);
    return res.status(200).json({ ok: true });
  }
}
