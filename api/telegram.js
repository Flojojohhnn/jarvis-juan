import { Redis } from '@upstash/redis';
import { chatLibre, extraerCamposDeResumen, extraerCamposDeNota, transcribirAudio } from '../lib/claude.js';
import { crearEvento, listarEventosHoy, listarEventosRango, eliminarEvento, actualizarEvento } from '../lib/calendar.js';
import { guardarLead, obtenerLead, buscarLeadPorNombre, actualizarLead, listarLeadsPrioritarios, normalizarTelefono, sincronizarLeadsConCalendar } from '../lib/leads.js';
import { enviarMensaje, descargarAudioTelegram } from '../lib/telegram.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HISTORIAL_KEY = (userId) => `jarvis:historial:${userId}`;
const MEMORIA_KEY = (userId) => `jarvis:memoria:${userId}`;
const HISTORIAL_TTL = 7 * 24 * 60 * 60;
const MAX_MENSAJES = 20;
const MAX_MEMORIA = 20;

function sanitizarHistorial(historial) {
  if (!Array.isArray(historial) || historial.length === 0) return [];
  for (let i = 0; i < historial.length; i++) {
    const msg = historial[i];
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return historial.slice(i);
    }
  }
  return [];
}

// Formatea la lista de eventos incluyendo el ID para que las tools de eliminar/actualizar funcionen
function formatearEventos(eventos) {
  if (!eventos.length) return 'No hay eventos.';
  return eventos.map((e) => {
    const inicio = e.start?.dateTime || e.start?.date || '';
    const hora = inicio.length > 10 ? inicio.slice(11, 16) : inicio;
    return `• ${hora} — ${e.summary || '(sin título)'} [id: ${e.id}]`;
  }).join('\n');
}

// Factory: crea el ejecutor de tools con el userId en closure para las operaciones de memoria
function crearEjecutorTools(userId) {
  return async function ejecutorTools(toolName, input) {
    console.log(`[TOOL] ${toolName}`);

    switch (toolName) {
      case 'crear_evento': {
        const evento = await crearEvento({
          summary: input.titulo,
          description: input.descripcion || '',
          start: input.fecha_hora_inicio,
          duracionMinutos: input.duracion_minutos || 60,
        });
        const inicio = evento.start?.dateTime?.slice(11, 16) || evento.start?.dateTime || '';
        const fin = evento.end?.dateTime?.slice(11, 16) || evento.end?.dateTime || '';
        return `Evento creado: "${evento.summary}" — ${inicio} a ${fin}`;
      }

      case 'listar_eventos_hoy': {
        const eventos = await listarEventosHoy();
        return formatearEventos(eventos);
      }

      case 'listar_eventos_rango': {
        const eventos = await listarEventosRango(input.desde, input.hasta);
        return formatearEventos(eventos);
      }

      case 'eliminar_evento': {
        await eliminarEvento(input.event_id);
        return `Evento eliminado.`;
      }

      case 'actualizar_evento': {
        const actualizado = await actualizarEvento(input.event_id, {
          summary: input.nuevo_titulo,
          description: input.nueva_descripcion,
          start: input.nueva_fecha_hora_inicio,
          duracionMinutos: input.nueva_duracion_minutos,
        });
        const inicio = actualizado.start?.dateTime?.slice(11, 16) || '';
        const fin = actualizado.end?.dateTime?.slice(11, 16) || '';
        return `Evento actualizado: "${actualizado.summary}" — ${inicio} a ${fin}`;
      }

      case 'guardar_lead': {
        const extraidos = await extraerCamposDeResumen(input.resumen_asistente);
        const telNormalizado = normalizarTelefono(input.telefono);
        console.log(`[TOOL] guardar_lead — key: lead:${telNormalizado}`);
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
          proxima_accion_fecha: extraidos.proxima_accion_fecha || null,
          ultima_gestion_fecha: null,
          ultima_gestion_tipo: null,
          ultima_gestion_detalle: null,
        });
        return (
          `Lead guardado: ${lead.nombre} (tel: ${lead.telefono})\n` +
          `• Probabilidad: ${lead.probabilidad_cierre}%\n• Etapa: ${lead.etapa}\n` +
          `• Plan: ${lead.plan_discutido || '—'}\n• Parte de pago: ${lead.usado_parte_pago}\n` +
          `• Competencia: ${lead.competencia}\n• Objeción: ${lead.objecion_principal || '—'}\n` +
          `• Próxima acción: ${lead.proxima_accion || '—'}${lead.proxima_accion_fecha ? ` (${lead.proxima_accion_fecha})` : ''}\n\n` +
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
          lead.telefono, cambios, 'manual', extraidos.resumen_corto || input.nota.slice(0, 200)
        );
        return (
          `Lead actualizado: ${actualizado.nombre}\n` +
          (cambios.probabilidad_cierre != null ? `• Nueva probabilidad: ${cambios.probabilidad_cierre}%\n` : '') +
          (cambios.objecion_principal ? `• Objeción: ${cambios.objecion_principal}\n` : '') +
          `• Nota registrada.`
        );
      }

      case 'listar_leads_prioritarios': {
        const leads = await listarLeadsPrioritarios(input.limite || 10);
        if (!leads.length) return 'No hay leads cargados todavía.';
        return leads.map((l, i) => {
          const urgencia = l.urgencia_razon ? `${l.urgencia_puntos}pts — ${l.urgencia_razon}` : 'sin urgencia';
          const proxima = l.proxima_accion
            ? `${l.proxima_accion}${l.proxima_accion_fecha ? ` (${l.proxima_accion_fecha.slice(0, 10)})` : ''}`
            : '—';
          return `${i + 1}. ${l.nombre} — score ${l.score} (prob ${l.probabilidad_cierre}% + urg ${urgencia})\n   Próxima: ${proxima}`;
        }).join('\n\n');
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
          `• No parseables (sin formato Tecnom): ${resumen.sin_parsear}`
        );
      }

      case 'guardar_memoria': {
        const memoriaActual = (await redis.get(MEMORIA_KEY(userId))) || [];
        const nueva = { fecha: new Date().toISOString().slice(0, 10), contenido: input.contenido };
        const memoriaActualizada = [nueva, ...memoriaActual].slice(0, MAX_MEMORIA);
        await redis.set(MEMORIA_KEY(userId), memoriaActualizada);
        return `Guardado en memoria permanente: "${input.contenido}"`;
      }

      case 'ver_memoria': {
        const memoriaActual = (await redis.get(MEMORIA_KEY(userId))) || [];
        if (!memoriaActual.length) return 'No tenés preferencias guardadas todavía.';
        return memoriaActual.map((e, i) => `${i + 1}. [${e.fecha}] ${e.contenido}`).join('\n');
      }

      case 'borrar_memoria': {
        const memoriaActual = (await redis.get(MEMORIA_KEY(userId))) || [];
        const idx = (input.indice || 1) - 1;
        if (idx < 0 || idx >= memoriaActual.length) return `No existe entrada número ${input.indice}.`;
        const borrada = memoriaActual[idx];
        memoriaActual.splice(idx, 1);
        await redis.set(MEMORIA_KEY(userId), memoriaActual);
        return `Entrada borrada: "${borrada.contenido}"`;
      }

      default:
        return `Tool desconocida: ${toolName}`;
    }
  };
}

export default async function handler(req, res) {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('no');
  }

  try {
    const update = req.body;
    const mensaje = update?.message;
    if (!mensaje) {
      return res.status(200).json({ ok: true });
    }

    const userId = String(mensaje.from.id);
    console.log(`[WEBHOOK] Mensaje de ${userId}: ${mensaje.text?.slice(0, 50) || '(sin texto)'}`);

    if (userId !== String(process.env.TELEGRAM_ALLOWED_USER_ID)) {
      await enviarMensaje(userId, 'No autorizado.');
      return res.status(200).json({ ok: true });
    }

    // Comandos slash
    if (mensaje.text === '/reset') {
      await redis.del(HISTORIAL_KEY(userId));
      await enviarMensaje(userId, '✅ Historial borrado. La memoria permanente se mantiene.');
      return res.status(200).json({ ok: true });
    }
    if (mensaje.text === '/resetmemoria') {
      await redis.del(MEMORIA_KEY(userId));
      await enviarMensaje(userId, '✅ Memoria permanente borrada.');
      return res.status(200).json({ ok: true });
    }
    if (mensaje.text === '/start') {
      await enviarMensaje(userId, [
        'Hola Juan. Soy Jarvis, tu asistente de ventas.',
        '',
        'Mandame texto o audio y arrancamos.',
        '',
        'Comandos:',
        '/reset — borrar historial de conversación',
        '/resetmemoria — borrar preferencias permanentes',
        '',
        'Para guardar preferencias decime: "a partir de ahora..." o "recordá siempre que..."',
      ].join('\n'));
      return res.status(200).json({ ok: true });
    }

    let texto = mensaje.text || null;

    // Audio / mensajes de voz
    if (!texto && (mensaje.voice || mensaje.audio)) {
      const fileId = (mensaje.voice || mensaje.audio).file_id;
      const audioData = await descargarAudioTelegram(fileId);
      if (!audioData) {
        await enviarMensaje(userId, 'No pude descargar el audio.');
        return res.status(200).json({ ok: true });
      }
      texto = await transcribirAudio(audioData.base64, audioData.mediaType);
      if (!texto) {
        await enviarMensaje(userId, 'No pude transcribir el audio.');
        return res.status(200).json({ ok: true });
      }
      await enviarMensaje(userId, `🎙️ _"${texto.slice(0, 300)}${texto.length > 300 ? '...' : ''}"_`);
    }

    if (!texto) {
      await enviarMensaje(userId, 'Mandame texto o audio.');
      return res.status(200).json({ ok: true });
    }

    // Cargar memoria permanente e historial de conversación
    const memoriaEntradas = (await redis.get(MEMORIA_KEY(userId))) || [];
    const memoriaTexto = memoriaEntradas.length > 0
      ? memoriaEntradas.map((e) => `• ${e.contenido}`).join('\n')
      : '';

    const historialRaw = (await redis.get(HISTORIAL_KEY(userId))) || [];
    const historialPrevio = sanitizarHistorial(historialRaw);
    const mensajes = [...historialPrevio, { role: 'user', content: texto }];

    console.log(`[CHAT] ${mensajes.length} mensajes, memoria: ${memoriaEntradas.length} entradas`);

    const ejecutor = crearEjecutorTools(userId);

    let respuesta;
    try {
      respuesta = await chatLibre(mensajes, ejecutor, memoriaTexto);
    } catch (err) {
      if (err.status === 400 && String(err.message || '').includes('tool_use')) {
        console.warn('[CHAT] Historial corrupto, reseteando');
        await redis.del(HISTORIAL_KEY(userId));
        respuesta = await chatLibre([{ role: 'user', content: texto }], ejecutor, memoriaTexto);
      } else {
        throw err;
      }
    }

    console.log(`[CHAT] Respuesta: ${respuesta.slice(0, 100)}`);

    const historialNuevo = [
      ...historialPrevio,
      { role: 'user', content: texto },
      { role: 'assistant', content: respuesta },
    ].slice(-MAX_MENSAJES);
    await redis.set(HISTORIAL_KEY(userId), historialNuevo, { ex: HISTORIAL_TTL });

    await enviarMensaje(userId, respuesta);
    console.log(`[WEBHOOK] Enviado a ${userId}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[ERROR] telegram webhook:', err.message, err.stack);
    try {
      await enviarMensaje(process.env.TELEGRAM_ALLOWED_USER_ID, `⚠️ Error: ${err.message}`);
    } catch {}
    return res.status(200).json({ ok: true });
  }
}
