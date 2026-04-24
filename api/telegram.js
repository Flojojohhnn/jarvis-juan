// api/telegram.js
'use strict';

const { Redis } = require('@upstash/redis');
const { chatLibre, extraerCamposDeResumen, extraerCamposDeNota, transcribirAudio } = require('../lib/claude.js');
const { crearEvento, listarEventosHoy, listarEventosRango } = require('../lib/calendar.js');
const {
  guardarLead, obtenerLead, buscarLeadPorNombre, actualizarLead,
  listarLeadsPrioritarios, normalizarTelefono, sincronizarLeadsConCalendar,
} = require('../lib/leads.js');
const { enviarMensaje, descargarAudioTelegram } = require('../lib/telegram.js');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HISTORIAL_KEY = (userId) => `jarvis:historial:${userId}`;
const HISTORIAL_TTL = 7 * 24 * 60 * 60;
const MAX_TURNOS = 10;

// ============================================================
// Ejecutor de tools
// ============================================================

async function ejecutorTools(toolName, input) {
  switch (toolName) {
    case 'crear_evento': {
      const evento = await crearEvento({
        summary: input.titulo,
        description: input.descripcion || '',
        start: input.fecha_hora_inicio,
        duracionMinutos: input.duracion_minutos || 15,
      });
      return `Evento creado: "${evento.summary}" el ${evento.start?.dateTime}`;
    }

    case 'listar_eventos_hoy': {
      const eventos = await listarEventosHoy();
      if (!eventos.length) return 'No hay eventos programados para hoy.';
      return eventos.map((e) => `• ${e.start?.dateTime || e.start?.date}: ${e.summary}`).join('\n');
    }

    case 'listar_eventos_rango': {
      const eventos = await listarEventosRango(input.desde, input.hasta);
      if (!eventos.length) return 'No hay eventos en ese rango.';
      return eventos.map((e) => `• ${e.start?.dateTime || e.start?.date}: ${e.summary}`).join('\n');
    }

    case 'guardar_lead': {
      const extraidos = await extraerCamposDeResumen(input.resumen_asistente);
      const lead = await guardarLead({
        nombre: input.nombre,
        telefono: input.telefono,
        email: input.email || null,
        modelo_interes: input.modelo_interes || null,
        resumen_asistente: input.resumen_asistente,
        probabilidad_cierre: extraidos.probabilidad_cierre,
        etapa: extraidos.etapa,
        plan_discutido: extraidos.plan_discutido,
        usado_parte_pago: extraidos.usado_parte_pago,
        competencia: extraidos.competencia,
        objecion_principal: extraidos.objecion_principal,
        proxima_accion: extraidos.proxima_accion_sugerida,
        proxima_accion_fecha: null,
        ultima_gestion_fecha: null,
        ultima_gestion_tipo: null,
        ultima_gestion_detalle: null,
      });
      return (
        `Lead guardado: ${lead.nombre} (${lead.telefono})\n` +
        `• Probabilidad: ${lead.probabilidad_cierre}\n` +
        `• Etapa: ${lead.etapa}\n` +
        `• Plan: ${lead.plan_discutido || '—'}\n` +
        `• Usado: ${lead.usado_parte_pago}\n` +
        `• Competencia: ${lead.competencia}\n` +
        `• Objeción: ${lead.objecion_principal || '—'}\n` +
        `• Próxima acción sugerida: ${lead.proxima_accion || '—'}\n\n` +
        `Corregí cualquier campo diciéndome.`
      );
    }

    case 'actualizar_lead_manual': {
      let lead = null;
      const posibleTel = normalizarTelefono(input.nombre_o_telefono);
      if (posibleTel && posibleTel.length >= 8) lead = await obtenerLead(posibleTel);
      if (!lead) lead = await buscarLeadPorNombre(input.nombre_o_telefono);
      if (!lead) return `No encontré lead con "${input.nombre_o_telefono}".`;

      const extraidos = await extraerCamposDeNota(input.nota);
      const cambios = {};
      if (input.nueva_probabilidad != null) cambios.probabilidad_cierre = input.nueva_probabilidad;
      else if (extraidos.nueva_probabilidad != null) cambios.probabilidad_cierre = extraidos.nueva_probabilidad;

      if (input.nueva_objecion) cambios.objecion_principal = input.nueva_objecion;
      else if (extraidos.nueva_objecion) cambios.objecion_principal = extraidos.nueva_objecion;

      const actualizado = await actualizarLead(
        lead.telefono, cambios, 'audio',
        extraidos.resumen_corto || input.nota.slice(0, 200)
      );
      return (
        `Lead actualizado: ${actualizado.nombre}\n` +
        (cambios.probabilidad_cierre ? `• Nueva probabilidad: ${cambios.probabilidad_cierre}\n` : '') +
        (cambios.objecion_principal ? `• Objeción: ${cambios.objecion_principal}\n` : '') +
        `• Nota registrada.`
      );
    }

    case 'listar_leads_prioritarios': {
      const leads = await listarLeadsPrioritarios(input.limite || 10);
      if (!leads.length) return 'No hay leads cargados todavía.';
      return leads.map((l, i) =>
        `${i + 1}. ${l.nombre} — score ${l.score} (prob ${l.probabilidad_cierre} + urg ${l.urgencia_puntos})\n` +
        `   ${l.urgencia_razon || 'sin urgencia especial'}\n` +
        `   Próxima: ${l.proxima_accion || '—'}${l.proxima_accion_fecha ? ` el ${l.proxima_accion_fecha.slice(0, 16).replace('T', ' ')}` : ''}`
      ).join('\n\n');
    }

    case 'ver_lead': {
      let lead = null;
      const posibleTel = normalizarTelefono(input.nombre_o_telefono);
      if (posibleTel && posibleTel.length >= 8) lead = await obtenerLead(posibleTel);
      if (!lead) lead = await buscarLeadPorNombre(input.nombre_o_telefono);
      if (!lead) return `No encontré lead con "${input.nombre_o_telefono}".`;
      return JSON.stringify(lead, null, 2);
    }

    case 'sincronizar_calendar': {
      const ahora = new Date();
      const desde = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
      const hasta = new Date(ahora.getTime() + 7 * 24 * 60 * 60 * 1000);
      const eventos = await listarEventosRango(desde.toISOString(), hasta.toISOString());
      const resumen = await sincronizarLeadsConCalendar(eventos);
      return (
        `Sincronización completa.\n` +
        `• Actualizados: ${resumen.actualizados.length} (${resumen.actualizados.join(', ') || '—'})\n` +
        `• Sin cargar en Jarvis: ${resumen.sin_match.length}\n` +
        (resumen.sin_match.length ? resumen.sin_match.map((l) => `  → ${l.nombre} ${l.telefono}`).join('\n') + '\n' : '') +
        `• No parseables (ignorados): ${resumen.sin_parsear}`
      );
    }

    default:
      return `Tool desconocida: ${toolName}`;
  }
}

// ============================================================
// Handler
// ============================================================

module.exports = async function handler(req, res) {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('no');
  }

  res.status(200).json({ ok: true });

  try {
    const update = req.body;
    const mensaje = update.message;
    if (!mensaje) return;

    const userId = String(mensaje.from.id);
    if (userId !== String(process.env.TELEGRAM_ALLOWED_USER_ID)) {
      await enviarMensaje(userId, 'No autorizado.');
      return;
    }

    let texto = mensaje.text;

    if (!texto && (mensaje.voice || mensaje.audio)) {
      const fileId = (mensaje.voice || mensaje.audio).file_id;
      const audioData = await descargarAudioTelegram(fileId);
      if (!audioData) {
        await enviarMensaje(userId, 'No pude descargar el audio. Intentá de nuevo.');
        return;
      }
      texto = await transcribirAudio(audioData.base64, audioData.mediaType);
      if (!texto) {
        await enviarMensaje(userId, 'No pude transcribir el audio. Intentá de nuevo.');
        return;
      }
      await enviarMensaje(userId, `🎙️ _"${texto.slice(0, 300)}${texto.length > 300 ? '...' : ''}"_`);
    }

    if (!texto) {
      await enviarMensaje(userId, 'Mandame texto o audio.');
      return;
    }

    const historialPrevio = (await redis.get(HISTORIAL_KEY(userId))) || [];
    const mensajes = [...historialPrevio, { role: 'user', content: texto }];
    const respuesta = await chatLibre(mensajes, ejecutorTools);

    const historialNuevo = [
      ...historialPrevio,
      { role: 'user', content: texto },
      { role: 'assistant', content: respuesta },
    ].slice(-MAX_TURNOS * 2);

    await redis.set(HISTORIAL_KEY(userId), historialNuevo, { ex: HISTORIAL_TTL });
    await enviarMensaje(userId, respuesta);
  } catch (err) {
    console.error('Error en telegram webhook:', err);
    try {
      await enviarMensaje(process.env.TELEGRAM_ALLOWED_USER_ID, `⚠️ Error: ${err.message}`);
    } catch {}
  }
};
