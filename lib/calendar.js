import { google } from 'googleapis';

function getCalendarClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    undefined,
    process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
  );
  return google.calendar({ version: 'v3', auth });
}

function getHoyAR() {
  // Argentina es UTC-3 sin DST
  const ahora = new Date();
  const arDate = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  return arDate.toISOString().slice(0, 10);
}

export async function listarEventosHoy() {
  const calendar = getCalendarClient();
  const hoy = getHoyAR();
  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: `${hoy}T00:00:00-03:00`,
    timeMax: `${hoy}T23:59:59-03:00`,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  return res.data.items || [];
}

export async function listarEventosRango(desde, hasta) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: typeof desde === 'string' ? desde : new Date(desde).toISOString(),
    timeMax: typeof hasta === 'string' ? hasta : new Date(hasta).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 200,
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  return res.data.items || [];
}

export async function crearEvento({ summary, description = '', start, duracionMinutos = 15 }) {
  const calendar = getCalendarClient();
  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + duracionMinutos * 60 * 1000);

  // Formatear end con offset -03:00 para mantener consistencia
  const endISO = endDate.toISOString().replace('Z', '-03:00');
  const startISO = start.includes('+') || start.includes('-03') ? start : start.replace('Z', '-03:00');

  const res = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: 'America/Argentina/Buenos_Aires' },
      end: { dateTime: endISO, timeZone: 'America/Argentina/Buenos_Aires' },
    },
  });
  return res.data;
}
