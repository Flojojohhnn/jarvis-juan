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
  const ahora = new Date();
  const arDate = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  return arDate.toISOString().slice(0, 10);
}

// Convierte 'YYYY-MM-DD' a 'YYYY-MM-DDT00:00:00-03:00' si falta la parte de hora.
// Google Calendar API requiere RFC 3339 completo para timeMin/timeMax.
function asDatetime(str) {
  if (typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str.trim())) {
    return `${str.trim()}T00:00:00-03:00`;
  }
  return typeof str === 'string' ? str : new Date(str).toISOString();
}

// Calcula el ISO de fin en timezone AR a partir de un start ISO y duración en minutos.
function calcularEndISO(startISO, duracionMinutos) {
  const startDate = new Date(startISO);
  const endDate = new Date(startDate.getTime() + duracionMinutos * 60 * 1000);
  // Expresar end en AR: restar 3h para obtener la hora local, luego etiquetar -03:00
  const endAR = new Date(endDate.getTime() - 3 * 60 * 60 * 1000);
  return endAR.toISOString().slice(0, 23) + '-03:00';
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
    timeMin: asDatetime(desde),
    timeMax: asDatetime(hasta),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 200,
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  return res.data.items || [];
}

export async function crearEvento({ summary, description = '', start, duracionMinutos = 15 }) {
  const calendar = getCalendarClient();
  // Asegurar que start tenga offset AR si viene sin él
  const startISO = start.includes('-03') || start.includes('+') ? start : `${start.slice(0, 19)}-03:00`;
  const endISO = calcularEndISO(startISO, duracionMinutos);

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

export async function eliminarEvento(eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId,
  });
}

export async function actualizarEvento(eventId, { summary, description, start, duracionMinutos }) {
  const calendar = getCalendarClient();
  const requestBody = {};

  if (summary) requestBody.summary = summary;
  if (description !== undefined) requestBody.description = description;

  if (start) {
    const startISO = start.includes('-03') || start.includes('+') ? start : `${start.slice(0, 19)}-03:00`;
    const endISO = calcularEndISO(startISO, duracionMinutos || 15);
    requestBody.start = { dateTime: startISO, timeZone: 'America/Argentina/Buenos_Aires' };
    requestBody.end = { dateTime: endISO, timeZone: 'America/Argentina/Buenos_Aires' };
  }

  const res = await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId,
    requestBody,
  });
  return res.data;
}
