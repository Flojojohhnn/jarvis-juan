// lib/leads.js
// CRUD de leads, scoring de urgencia, y parser de eventos de Calendar Tecnom

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const LEAD_KEY_PREFIX = 'lead:';
const MAX_HISTORIAL = 20;

// ============================================================
// Utilidades de normalización
// ============================================================

/**
 * Normaliza un teléfono argentino a solo dígitos del número local.
 * Input: "+54 9 2604 000159", "+542604000159", "2604-000159", etc.
 * Output: "2604000159" (10 dígitos típicos, o lo que venga limpio)
 */
export function normalizarTelefono(tel) {
  if (!tel) return null;
  const soloDigitos = String(tel).replace(/\D/g, '');
  // Saca prefijo 54 y 9 inicial si están
  let limpio = soloDigitos;
  if (limpio.startsWith('54')) limpio = limpio.slice(2);
  if (limpio.startsWith('9')) limpio = limpio.slice(1);
  return limpio;
}

function leadKey(telefono) {
  return `${LEAD_KEY_PREFIX}${normalizarTelefono(telefono)}`;
}

// ============================================================
// CRUD básico
// ============================================================

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

  const nuevaEntrada = {
    fecha: new Date().toISOString(),
    fuente: fuenteUpdate,
    texto: textoUpdate,
  };

  const leadActualizado = {
    ...lead,
    ...cambios,
    historial_updates: [nuevaEntrada, ...(lead.historial_updates || [])].slice(0, MAX_HISTORIAL),
  };

  await redis.set(key, leadActualizado);
  return leadActualizado;
}

// ============================================================
// Scoring de urgencia (puro, sin LLM)
// ============================================================

/**
 * Calcula puntos de urgencia basándose en fechas y probabilidad.
 * Retorna { puntos, razon } para mostrar en briefing.
 */
export function calcularUrgencia(lead) {
  const ahora = new Date();
  const hoy = ahora.toISOString().slice(0, 10);

  const proxima = lead.proxima_accion_fecha ? new Date(lead.proxima_accion_fecha) : null;
  const ultima = lead.ultima_gestion_fecha ? new Date(lead.ultima_gestion_fecha) : null;
  const diasSinContacto = ultima
    ? Math.floor((ahora - ultima) / (1000 * 60 * 60 * 24))
    : 999;

  // Regla 1: próxima acción vencida
  if (proxima && proxima < ahora) {
    const diasVencido = Math.floor((ahora - proxima) / (1000 * 60 * 60 * 24));
    return {
      puntos: 50,
      razon: `Compromiso vencido hace ${diasVencido} día${diasVencido !== 1 ? 's' : ''}`,
    };
  }

  // Regla 2: próxima acción hoy
  if (proxima && proxima.toISOString().slice(0, 10) === hoy) {
    return { puntos: 40, razon: 'Acción programada hoy' };
  }

  // Regla 3: lead caliente enfriándose
  if (diasSinContacto > 7 && (lead.probabilidad_cierre || 0) >= 60) {
    return {
      puntos: 30,
      razon: `${diasSinContacto} días sin contacto (lead caliente)`,
    };
  }

  // Regla 4: abandono genérico
  if (diasSinContacto > 14) {
    return { puntos: 20, razon: `${diasSinContacto} días sin contacto` };
  }

  return { puntos: 0, razon: null };
}

export function calcularScoreFinal(lead) {
  const urgencia = calcularUrgencia(lead);
  const prob = lead.probabilidad_cierre || 0;
  return {
    score: prob + urgencia.puntos,
    probabilidad: prob,
    urgencia_puntos: urgencia.puntos,
    urgencia_razon: urgencia.razon,
  };
}

// ============================================================
// Listado priorizado
// ============================================================

export async function listarLeadsPrioritarios(limite = 10) {
  const leads = await listarTodosLeads();
  return leads
    .map((lead) => ({ ...lead, ...calcularScoreFinal(lead) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limite);
}

// ============================================================
// Parser de eventos Tecnom en Calendar
// ============================================================

/**
 * Intenta extraer datos estructurados de un evento de Calendar creado por Tecnom.
 * Formato observado:
 *   Título: "NOMBRE APELLIDO - Acción"
 *   Descripción contiene:
 *     ACCIÓN REALIZADA: <texto>
 *     PRÓXIMA ACCIÓN: <texto>
 *     Celular: +54...
 *     Email: ...
 * Retorna null si no parece un evento Tecnom parseable.
 */
export function parsearEventoTecnom(evento) {
  const titulo = evento.summary || '';
  const descripcion = evento.description || '';

  // El celular es el match key, si no está el evento no sirve
  const matchCelular = descripcion.match(/Celular:\s*([+\d\s\-()]+)/i);
  if (!matchCelular) return null;

  const telefono = normalizarTelefono(matchCelular[1]);
  if (!telefono) return null;

  // Nombre: viene del título antes del guión
  const matchNombre = titulo.match(/^(.+?)\s*-\s*/);
  const nombre = matchNombre ? matchNombre[1].trim() : titulo.trim();

  // Email
  const matchEmail = descripcion.match(/Email:\s*([^\s]+)/i);
  const email = matchEmail ? matchEmail[1].trim() : null;

  // Acción realizada (tolera con o sin tilde en ACCIÓN/ACCION)
  const matchRealizada = descripcion.match(
    /ACCI[ÓO]N REALIZADA:\s*([\s\S]*?)(?=\n\s*PR[ÓO]XIMA ACCI[ÓO]N:|\n\s*Detalles|\n\s*Datos|$)/i
  );
  const accionRealizada = matchRealizada ? matchRealizada[1].trim() : null;

  // Próxima acción (tolera con o sin tilde en PRÓXIMA/PROXIMA y ACCIÓN/ACCION)
  const matchProxima = descripcion.match(
    /PR[ÓO]XIMA ACCI[ÓO]N:\s*([\s\S]*?)(?=\n\s*Detalles|\n\s*Datos|$)/i
  );
  const proximaAccion = matchProxima ? matchProxima[1].trim() : null;

  // Detectar tipo de última gestión del texto
  let tipoGestion = null;
  if (accionRealizada) {
    const primeraLinea = accionRealizada.split('\n')[0].toUpperCase();
    if (primeraLinea.includes('LLAMADO')) tipoGestion = 'llamado';
    else if (primeraLinea.includes('WHATSAPP') || primeraLinea.includes('WA'))
      tipoGestion = 'whatsapp';
    else if (primeraLinea.includes('VISITA')) tipoGestion = 'visita';
    else if (primeraLinea.includes('EMAIL') || primeraLinea.includes('MAIL'))
      tipoGestion = 'email';
  }

  // Fecha del evento (cuándo sucedió o sucederá la gestión)
  const fechaEvento = evento.start?.dateTime || evento.start?.date || null;

  return {
    nombre,
    telefono,
    email,
    accion_realizada: accionRealizada,
    proxima_accion: proximaAccion,
    tipo_gestion: tipoGestion,
    fecha_evento: fechaEvento,
    evento_id: evento.id,
  };
}

/**
 * Dada una lista de eventos de Calendar, actualiza los leads existentes en Redis.
 * NO crea leads nuevos: solo actualiza los que ya cargaste desde el Asistente.
 * Retorna resumen de qué se actualizó.
 */
export async function sincronizarLeadsConCalendar(eventos) {
  const ahora = new Date();
  const resumen = { actualizados: [], sin_match: [], sin_parsear: 0 };

  for (const evento of eventos) {
    const parsed = parsearEventoTecnom(evento);
    if (!parsed) {
      resumen.sin_parsear++;
      continue;
    }

    const lead = await obtenerLead(parsed.telefono);
    if (!lead) {
      resumen.sin_match.push({ nombre: parsed.nombre, telefono: parsed.telefono });
      continue;
    }

    const fechaEvento = parsed.fecha_evento ? new Date(parsed.fecha_evento) : null;
    const esPasado = fechaEvento && fechaEvento < ahora;
    const esFuturo = fechaEvento && fechaEvento >= ahora;

    const cambios = {};
    let textoUpdate = '';

    // Si el evento ya pasó y tiene acción realizada, es una gestión hecha
    if (esPasado && parsed.accion_realizada) {
      const fechaUltimaActual = lead.ultima_gestion_fecha
        ? new Date(lead.ultima_gestion_fecha)
        : null;
      // Solo actualiza si este evento es más reciente que el último registrado
      if (!fechaUltimaActual || fechaEvento > fechaUltimaActual) {
        cambios.ultima_gestion_fecha = parsed.fecha_evento;
        cambios.ultima_gestion_tipo = parsed.tipo_gestion || 'otro';
        cambios.ultima_gestion_detalle = parsed.accion_realizada;
        textoUpdate = `Gestión ${parsed.tipo_gestion || ''}: ${parsed.accion_realizada.slice(0, 100)}`;
      }
    }

    // Si hay un evento futuro, es la próxima acción programada
    if (esFuturo) {
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
