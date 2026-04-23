// lib/telegram.js
import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Envía un mensaje a un chat de Telegram.
 */
export async function enviarMensaje(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `${TELEGRAM_API}${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('Telegram sendMessage error:', errText);
    // Fallback sin Markdown por si el texto tiene caracteres problemáticos
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

/**
 * Verifica si el usuario que escribió es el usuario autorizado (Juan).
 */
export function isAuthorizedUser(userId) {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  return String(userId) === String(allowed);
}

/**
 * Descarga un audio de Telegram y lo transcribe con Claude.
 * @param {string} fileId - el file_id que viene en message.voice o message.audio
 * @returns {Promise<string|null>} - texto transcripto o null si falló
 */
export async function transcribirAudioTelegram(fileId) {
  try {
    // 1. Pedir a Telegram el path del archivo
    const getFileRes = await fetch(
      `${TELEGRAM_API}${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const getFileData = await getFileRes.json();
    if (!getFileData.ok) return null;

    const filePath = getFileData.result.file_path;

    // 2. Descargar el archivo
    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // 3. Detectar media type (audios de Telegram voice son .oga/ogg)
    let mediaType = 'audio/ogg';
    if (filePath.endsWith('.mp3')) mediaType = 'audio/mpeg';
    else if (filePath.endsWith('.m4a')) mediaType = 'audio/mp4';
    else if (filePath.endsWith('.wav')) mediaType = 'audio/wav';

    // 4. Transcribir con Claude
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: 'text',
              text: 'Transcribí este audio al español rioplatense, tal cual se dice. Devolvé SOLO la transcripción, sin comentarios.',
            },
          ],
        },
      ],
    });

    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    console.error('Error transcribiendo audio:', err);
    return null;
  }
}
