const TELEGRAM_API = 'https://api.telegram.org/bot';

/**
 * Envía un mensaje a un chat de Telegram.
 */
export async function sendMessage(chatId, text) {
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
