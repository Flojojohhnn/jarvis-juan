const TELEGRAM_API = 'https://api.telegram.org/bot';

export async function enviarMensaje(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `${TELEGRAM_API}${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    // Fallback sin Markdown si falla (e.g. caracteres especiales sin escapar)
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

export function isAuthorizedUser(userId) {
  return String(userId) === String(process.env.TELEGRAM_ALLOWED_USER_ID);
}

export async function descargarAudioTelegram(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const getFileRes = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${fileId}`);
  const getFileData = await getFileRes.json();
  if (!getFileData.ok) return null;

  const filePath = getFileData.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  // Los audios de voz de Telegram son .oga (audio/ogg)
  let mediaType = 'audio/ogg';
  if (filePath.endsWith('.mp3')) mediaType = 'audio/mpeg';
  else if (filePath.endsWith('.m4a')) mediaType = 'audio/mp4';
  else if (filePath.endsWith('.wav')) mediaType = 'audio/wav';

  return { base64, mediaType, filePath };
}
