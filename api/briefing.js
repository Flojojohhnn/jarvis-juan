import { listEvents, formatEventsForPrompt } from '../lib/calendar.js';
import { briefingMatutino, briefingMediodia, briefingCierre } from '../lib/claude.js';
import { sendMessage } from '../lib/telegram.js';

/**
 * Endpoint de briefings. Se dispara por Vercel Cron en 3 horarios:
 * - /api/briefing?tipo=matutino   -> 08:30 AR
 * - /api/briefing?tipo=mediodia   -> 14:00 AR
 * - /api/briefing?tipo=cierre     -> 19:00 AR
 *
 * Las horas en vercel.json están en UTC (Mendoza es UTC-3).
 */
export default async function handler(req, res) {
  // Seguridad: Vercel envía el CRON_SECRET en el header Authorization
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tipo = req.query.tipo;
  const chatId = process.env.TELEGRAM_ALLOWED_USER_ID;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  try {
    const now = new Date();
    const inicioHoy = new Date(now);
    inicioHoy.setHours(0, 0, 0, 0);
    const finHoy = new Date(now);
    finHoy.setHours(23, 59, 59, 999);

    let texto;

    if (tipo === 'matutino') {
      const eventos = await listEvents({
        calendarId,
        timeMin: now,
        timeMax: finHoy,
      });
      const resumen = formatEventsForPrompt(eventos);
      texto = await briefingMatutino(resumen);
    } else if (tipo === 'mediodia') {
      const eventos = await listEvents({
        calendarId,
        timeMin: now,
        timeMax: finHoy,
      });
      const resumen = formatEventsForPrompt(eventos);
      texto = await briefingMediodia(resumen);
    } else if (tipo === 'cierre') {
      const manana = new Date(now);
      manana.setDate(manana.getDate() + 1);
      const inicioManana = new Date(manana);
      inicioManana.setHours(0, 0, 0, 0);
      const finManana = new Date(manana);
      finManana.setHours(23, 59, 59, 999);

      const eventos = await listEvents({
        calendarId,
        timeMin: inicioManana,
        timeMax: finManana,
      });
      const resumen = formatEventsForPrompt(eventos);
      texto = await briefingCierre(resumen);
    } else {
      return res.status(400).json({ error: 'tipo inválido' });
    }

    await sendMessage(chatId, texto);
    return res.status(200).json({ ok: true, tipo });
  } catch (error) {
    console.error('Error en briefing:', error);
    // Intentar avisarle a Juan que algo falló
    try {
      await sendMessage(
        chatId,
        `Falló el briefing ${tipo}. Error: ${error.message}. Revisá los logs de Vercel.`
      );
    } catch (_) {}
    return res.status(500).json({ error: error.message });
  }
}
