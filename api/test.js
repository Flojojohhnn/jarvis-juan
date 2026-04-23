import { listEvents, formatEventsForPrompt } from '../lib/calendar.js';
import { briefingMatutino } from '../lib/claude.js';
import { sendMessage } from '../lib/telegram.js';

/**
 * Endpoint de prueba manual. Llamalo desde el browser pasando ?key=TU_CRON_SECRET
 * para verificar que todo funciona antes de esperar a que corra el cron.
 *
 * Ejemplo: https://tu-app.vercel.app/api/test?key=xxxxx
 */
export default async function handler(req, res) {
  if (req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const chatId = process.env.TELEGRAM_ALLOWED_USER_ID;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  try {
    const now = new Date();
    const fin = new Date(now);
    fin.setHours(23, 59, 59, 999);

    const eventos = await listEvents({ calendarId, timeMin: now, timeMax: fin });
    const resumen = formatEventsForPrompt(eventos);
    const texto = await briefingMatutino(resumen);

    await sendMessage(chatId, `[TEST] ${texto}`);

    return res.status(200).json({
      ok: true,
      eventos_encontrados: eventos.length,
      resumen,
      respuesta_claude: texto,
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}
