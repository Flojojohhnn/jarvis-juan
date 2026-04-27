// lib/leads.js

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const LEAD_KEY_PREFIX = 'lead:';
const MAX_HISTORIAL = 20;

export function normalizarTelefono(tel) {
  if (!tel) return null;
  let limpio = String(tel).replace(/\D/g, '');
  if (limpio.startsWith('54')) limpio = limpio.slice(2);
  if (limpio.startsWith('9')) limpio = limpio.slice(1);
  return limpio;
}

function leadKey(telefono) {
  return `${LEAD_KEY_PREFIX}${normalizarTelefono(telefono)}`;
}

export async function guardarLead(lead) {
  if (!lead.telefono) throw new Error('Lead sin teléfono');
  const key = leadKey(lead.telefono);
  const existente = await redis.get(key);
  const historialPrevio = existente?.historial_updates || [];
  const nuevaEntrada = {
    fecha: new Date().toISOString(),
    fuente: 'asistente',
    texto: `Lead ${existente ? 'actualizado' : 'creado'} desde Asistente de Ventas`,
  };
  const leadFinal = {
    ...lead,
    telefono: normalizarTelefono(lead.telefono),
    fecha_resumen: new Date().toISOString().slice(0, 10),
    historial_updates: [nuevaEntrada, ...historialPrevio].slice(0, MAX_HISTORIAL),
  };
  await redis.set(key, leadFinal);
  return leadFinal;
}

export async function obtenerLead(telefono) {
  return await redis.get(leadKey(telefono));
}

export async function buscarLeadPorNombre(nombre) {
  const keys = await redis.keys(`${LEAD_KEY_PREFIX}*`);
  if (!keys.length) return null;
  const leads = await Promise.all(keys.map((k) => redis.get(k)));
  const nombreLower = nombre.toLowerCase().trim();
  return leads.find((l) => l?.nombre?.toLowerCase().includes(nombreLower)) || null;
}

export async function listarTodosLeads() {
  const keys = await redis.keys(`${LEAD_KEY_PREFIX}*`);
  if (!keys.length) return [];
  const leads = await Promise.all(keys.map((k) => redis.get(k)));
  return leads.filter(Boolean);
}

export async function actualizarLead(telefono, cambios, fuenteUpdate, textoUpdate) {
  const key = leadKey(telefono);
  const lead = await redis.get(key);
  if (!lead) return null;
  const nuevaEntrada = { fecha: new Date().toISOString(), fuente: fuenteUpdate, texto: textoUpdate };
  const leadActualizado = {
    ...lead,
    ...cambios,
    historial_updates: [nuevaEntrada, ...(lead.historial_updates || [])].slice(0, MAX_HISTORIAL),
  };
  await redis.set(key, leadActualizado);
  return leadActualizado;
}

export function calcularUrgencia(lead) {
  const ahora = new Date();
  // Siempre comparar fechas en timezone AR (UTC-3)
  const hoy = new Date(ahora.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const proxima = lead.proxima_accion_fecha ? new Date(lead.proxima_accion_fecha) : null;
  const ultima = lead.ultima_gestion_fecha ? new Date(lead.ultima_gestion_fecha) : null;
  // null = lead nuevo sin gestiones, no "999 días"
  const diasSinContacto = ultima ? Math.floor((ahora - ultima) / 86400000) : null;

  if (proxima && proxima < ahora) {
    const dias = Math.floor((ahora - proxima) / 86400000);
    return { puntos: 50, razon: `Compromiso vencido hace ${dias} día${dias !== 1 ? 's' : ''}` };
  }
  // Comparar fecha de proxima en AR, no en UTC
  if (proxima && new Date(proxima.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10) === hoy) {
    return { puntos: 40, razon: 'Acción programada hoy' };
  }
  if (diasSinContacto !== null && diasSinContacto > 7 && (lead.probabilidad_cierre || 0) >= 60) {
    return { puntos: 30, razon: `${diasSinContacto} días sin contacto (lead caliente)` };
  }
  if (diasSinContacto !== null && diasSinContacto > 14) {
    return { puntos: 20, razon: `${diasSinContacto} días sin contacto` };
  }
  return { puntos: 0, razon: null };
}

export function calcularScoreFinal(lead) {
  const urgencia = calcularUrgencia(lead);
  const prob = lead.probabilidad_cierre || 0;
  return { score: prob + urgencia.puntos, probabilidad: prob, urgencia_puntos: urgencia.puntos, urgencia_razon: urgencia.razon };
}

export async function listarLeadsPrioritarios(limite = 10) {
  const leads = await listarTodosLeads();
  return leads
    .map((lead) => ({ ...lead, ...calcularScoreFinal(lead) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limite);
}

export function parsearEventoTecnom(evento) {
  const titulo = evento.summary || '';
  // Normalizar CRLF (Tecnom puede generar saltos de línea Windows)
  const descripcion = (evento.description || '').replace(/\r\n/g, '\n');

  const matchCelular = descripcion.match(/Celular:\s*([+\d\s\-()]+)/i);
  if (!matchCelular) return null;
  const telefono = normalizarTelefono(matchCelular[1]);
  if (!telefono) return null;

  const matchNombre = titulo.match(/^(.+?)\s*-\s*/);
  const nombre = matchNombre ? matchNombre[1].trim() : titulo.trim();

  const matchEmail = descripcion.match(/Email:\s*([^\s]+)/i);
  const email = matchEmail ? matchEmail[1].trim() : null;

  const matchRealizada = descripcion.match(
    /ACCI[ÓO]N REALIZADA:\s*([\s\S]*?)(?=\n\s*PR[ÓO]XIMA ACCI[ÓO]N:|\n\s*Detalles|\n\s*Datos|$)/i
  );
  const accionRealizada = matchRealizada ? matchRealizada[1].trim() : null;

  const matchProxima = descripcion.match(
    /PR[ÓO]XIMA ACCI[ÓO]N:\s*([\s\S]*?)(?=\n\s*Detalles|\n\s*Datos|$)/i
  );
  const proximaAccion = matchProxima ? matchProxima[1].trim() : null;

  let tipoGestion = null;
  if (accionRealizada) {
    const primera = accionRealizada.split('\n')[0].toUpperCase();
    if (primera.includes('LLAMADO')) tipoGestion = 'llamado';
    else if (primera.includes('WHATSAPP') || primera.includes('WA')) tipoGestion = 'whatsapp';
    else if (primera.includes('VISITA')) tipoGestion = 'visita';
    else if (primera.includes('EMAIL') || primera.includes('MAIL')) tipoGestion = 'email';
  }

  return {
    nombre, telefono, email,
    accion_realizada: accionRealizada,
    proxima_accion: proximaAccion,
    tipo_gestion: tipoGestion,
    fecha_evento: evento.start?.dateTime || evento.start?.date || null,
    evento_id: evento.id,
  };
}

export async function sincronizarLeadsConCalendar(eventos) {
  const ahora = new Date();
  const resumen = { actualizados: [], sin_match: [], sin_parsear: 0 };

  for (const evento of eventos) {
    const parsed = parsearEventoTecnom(evento);
    if (!parsed) { resumen.sin_parsear++; continue; }

    const lead = await obtenerLead(parsed.telefono);
    if (!lead) {
      resumen.sin_match.push({ nombre: parsed.nombre, telefono: parsed.telefono });
      continue;
    }

    const fechaEvento = parsed.fecha_evento ? new Date(parsed.fecha_evento) : null;
    const cambios = {};
    let textoUpdate = '';

    if (fechaEvento && fechaEvento < ahora && parsed.accion_realizada) {
      const fechaUltimaActual = lead.ultima_gestion_fecha ? new Date(lead.ultima_gestion_fecha) : null;
      if (!fechaUltimaActual || fechaEvento > fechaUltimaActual) {
        cambios.ultima_gestion_fecha = parsed.fecha_evento;
        cambios.ultima_gestion_tipo = parsed.tipo_gestion || 'otro';
        cambios.ultima_gestion_detalle = parsed.accion_realizada;
        textoUpdate = `Gestión ${parsed.tipo_gestion || ''}: ${parsed.accion_realizada.slice(0, 100)}`;
      }
    }

    if (fechaEvento && fechaEvento >= ahora) {
      cambios.proxima_accion = parsed.proxima_accion || evento.summary;
      cambios.proxima_accion_fecha = parsed.fecha_evento;
    }

    if (Object.keys(cambios).length > 0) {
      await actualizarLead(parsed.telefono, cambios, 'calendar', textoUpdate || 'Sync calendar');
      resumen.actualizados.push(parsed.nombre);
    }
  }

  return resumen;
}
