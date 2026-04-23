import { google } from 'googleapis';

/**
 * Crea un cliente autenticado de Google Calendar usando las credenciales
 * del service account almacenadas en variables de entorno.
 */
function getCalendarClient() {
  const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };

  const auth = new google.auth.JWT(
    credentials.client_email,
    undefined,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );

  return google.calendar({ version: 'v3', auth });
}

/**
 * Lee eventos del calendario entre dos fechas.
 * calendarId: normalmente el email de Juan (el calendar principal).
 */
export async function listEvents({ calendarId, timeMin, timeMax }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 100,
  });
  return res.data.items || [];
}

/**
 * Crea un evento en el calendario.
 */
export async function createEvent({ calendarId, summary, description, start, end }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: start, timeZone: 'America/Argentina/Mendoza' },
      end: { dateTime: end, timeZone: 'America/Argentina/Mendoza' },
    },
  });
  return res.data;
}

/**
 * Formatea una lista de eventos en texto legible para pasar como contexto a Claude.
 */
export function formatEventsForPrompt(events) {
  if (events.length === 0) return 'No hay eventos agendados.';
  return events
    .map((ev) => {
      const start = ev.start?.dateTime || ev.start?.date;
      const hora = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString('es-AR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Argentina/Mendoza',
          })
        : 'todo el día';
      const titulo = ev.summary || '(sin título)';
      const desc = ev.description ? ` | ${ev.description.slice(0, 200)}` : '';
      return `- ${hora} · ${titulo}${desc}`;
    })
    .join('\n');
}
