// api/briefing.js
'use strict';

const { listarEventosRango } = require('../lib/calendar.js');
const { sincronizarLeadsConCalendar, listarLeadsPrioritarios } = require('../lib/leads.js');
const { generarBriefing } = require('../lib/claude.js');
const { enviarMensaje } = require('../lib/telegram.js');

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const ahora = new Date();
    const desde = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
    const hasta = new Date(ahora.getTime() + 7 * 24 * 60 * 60 * 1000);

    const eventos = await listarEventosRango(desde.toISOString(), hasta.toISOString());
    const resumenSync = await sincronizarLeadsConCalendar(eventos);
    const leadsPrioritarios = await listarLeadsPrioritarios(10);

    const hoyISO = ahora.toISOString().slice(0, 10);
    const eventosHoy = eventos
      .filter((e) => {
        const inicio = e.start?.dateTime || e.start?.date;
        return inicio && inicio.slice(0, 10) === hoyISO;
      })
      .map((e) => ({ titulo: e.summary, inicio: e.start?.dateTime || e.start?.date }));

    const horaAR = new Date(
      ahora.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })
    ).getHours();
    let tipoBriefing = 'matutino';
    if (horaAR >= 12 && horaAR < 17) tipoBriefing = 'mediodia';
    else if (horaAR >= 17) tipoBriefing = 'cierre';

    const payload = {
      tipo: tipoBriefing,
      fecha: hoyISO,
      leads_prioritarios: leadsPrioritarios.map((l) => ({
        nombre: l.nombre,
        telefono: l.telefono,
        modelo: l.modelo_interes,
        probabilidad_cierre: l.probabilidad_cierre,
        urgencia_puntos: l.urgencia_puntos,
        urgencia_razon: l.urgencia_razon,
        score_total: l.score,
        proxima_accion: l.proxima_accion,
        proxima_accion_fecha: l.proxima_accion_fecha,
        ultima_gestion_detalle: l.ultima_gestion_detalle,
        objecion_principal: l.objecion_principal,
        etapa: l.etapa,
      })),
      eventos_hoy: eventosHoy,
      leads_en_calendar_sin_procesar: resumenSync.sin_match,
    };

    const textoBriefing = await generarBriefing(payload);

    let mensajeFinal = textoBriefing;
    if (resumenSync.sin_match.length > 0) {
      mensajeFinal += '\n\n📋 *Leads en calendar sin cargar en Jarvis:*';
      resumenSync.sin_match.forEach((l) => {
        mensajeFinal += `\n• ${l.nombre} — ${l.telefono}`;
      });
      mensajeFinal += '\n\n_Buscalos en Tecnom, procesalos con el Asistente de Ventas y cargalos al bot._';
    }

    await enviarMensaje(process.env.TELEGRAM_ALLOWED_USER_ID, mensajeFinal);

    return res.status(200).json({
      ok: true,
      tipo: tipoBriefing,
      leads_actualizados: resumenSync.actualizados.length,
      leads_sin_match: resumenSync.sin_match.length,
    });
  } catch (err) {
    console.error('Error en briefing:', err);
    try {
      await enviarMensaje(process.env.TELEGRAM_ALLOWED_USER_ID, `⚠️ Error generando briefing: ${err.message}`);
    } catch {}
    return res.status(500).json({ error: err.message });
  }
};
