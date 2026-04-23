# Jarvis Juan

Asistente personal de Juan en Telegram, corriendo en Vercel. Lee Google Calendar (que sincroniza con Tecnom), analiza con Claude Haiku 4.5 y manda briefings tres veces al día. También permite chat bidireccional con tool use para crear/consultar eventos.

## Arquitectura

```
Tecnom → Google Calendar → Vercel Cron (3x/día) → Claude Haiku → Telegram → vos
                              ↑
                 Webhook Telegram ← vos (consultas/acciones)
```

## Qué vas a necesitar

1. Cuenta de Vercel (Pro, que ya tenés)
2. Cuenta de Anthropic con API key
3. Una cuenta de Google Cloud (gratis) para el service account
4. La app de Telegram
5. Upstash Redis (podés reusar la de Óvalo Closer)

## Setup paso a paso

### 1. Clonar el repo y subirlo a GitHub

```bash
git init
git add .
git commit -m "initial"
# crear repo en github, después:
git remote add origin https://github.com/Flojojohhnn/jarvis-juan.git
git push -u origin main
```

### 2. Crear el bot de Telegram

1. Abrí Telegram y buscá **@BotFather**
2. Enviá `/newbot`
3. Ponele un nombre (ej: "Jarvis Juan")
4. Ponele un username que termine en `bot` (ej: `jarvis_juan_bot`)
5. **Guardá el token** que te da - se ve así: `123456789:ABCdef...`
6. Ahora escribile a **@userinfobot** para obtener tu user ID numérico

### 3. Generar los secrets

En tu terminal (o en la consola de macOS, Linux, o WSL):

```bash
openssl rand -hex 32   # para TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32   # para CRON_SECRET
```

Guardá esos dos strings, los vas a necesitar.

### 4. Crear el Service Account de Google Calendar

1. Andá a https://console.cloud.google.com
2. Creá un proyecto nuevo ("jarvis-juan" o como quieras)
3. Habilitá la **Google Calendar API**: menú → APIs y servicios → Biblioteca → buscar "Google Calendar API" → Habilitar
4. Creá el service account: menú → IAM y administración → Cuentas de servicio → Crear cuenta de servicio
   - Nombre: `jarvis-juan-sa`
   - Click en Crear y continuar → Listo
5. Entrá a la cuenta creada, pestaña **Claves** → Agregar clave → Crear clave nueva → JSON
6. Te descarga un archivo JSON. **Abrilo** y fijate en dos campos:
   - `client_email` → va en `GOOGLE_CLIENT_EMAIL`
   - `private_key` → va en `GOOGLE_PRIVATE_KEY` (con los `\n` literales)
7. **Compartí tu Google Calendar con el service account**:
   - Abrí Google Calendar
   - Configuración del calendar principal → Compartir con usuarios o grupos específicos
   - Agregá el email del service account (el que termina en `.iam.gserviceaccount.com`)
   - Permiso: **"Realizar cambios en eventos"**
8. Tu `GOOGLE_CALENDAR_ID` es tu email de Google (el que usás para Calendar).

### 5. Desplegar a Vercel

```bash
npm install
npx vercel
```

La primera vez te va a preguntar si linkear a un proyecto existente - decile **No** y creá uno nuevo llamado `jarvis-juan`.

Después configurá todas las variables de entorno en el dashboard de Vercel (proyecto → Settings → Environment Variables), copiando desde el `.env.example`.

Para la `GOOGLE_PRIVATE_KEY`: pegala **tal como está en el JSON**, con los `\n` literales. El código se encarga de convertirlos.

Después desplegá a producción:

```bash
npx vercel --prod
```

Guardá la URL que te da, por ejemplo: `https://jarvis-juan.vercel.app`

### 6. Registrar el webhook de Telegram

Desde tu terminal, reemplazando los valores:

```bash
curl -X POST "https://api.telegram.org/bot<TU_TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://jarvis-juan.vercel.app/api/telegram",
    "secret_token": "<TU_TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Si recibís `{"ok":true,"result":true,"description":"Webhook was set"}` está todo bien.

### 7. Probar

**Prueba 1 - briefing manual:**

Desde el browser, andá a:

```
https://jarvis-juan.vercel.app/api/test?key=<TU_CRON_SECRET>
```

Deberías recibir un mensaje de Telegram con un briefing (va a decir `[TEST]` al principio).

**Prueba 2 - chat:**

Escribile al bot en Telegram algo como:
- "¿Qué tengo hoy?"
- "Agendame llamar a Emmanuel mañana a las 10"
- "¿Qué tengo esta semana?"

### 8. Los cron jobs

Están en `vercel.json` en **UTC** (Mendoza es UTC-3):

- `30 11 * * *` → **08:30 Mendoza** (briefing matutino)
- `0 17 * * *` → **14:00 Mendoza** (mediodía)
- `0 22 * * *` → **19:00 Mendoza** (cierre)

Los crons solo corren en deployments de **producción** (no en preview).

## Costos estimados

- Vercel: $0 extra (ya tenés Pro)
- Upstash Redis: $0 extra (free tier alcanza de sobra)
- Anthropic API (Haiku 4.5 a $1/$5 por M tokens):
  - 3 briefings × 30 días × ~2000 tokens = ~180K tokens/mes → ~$0.50/mes
  - Chat bidireccional: depende del uso, pero con conversaciones cortas no vas a pasar de $2-3/mes

**Total: ~$3-5 USD/mes.**

## Cómo iterar los prompts

Los prompts están en `lib/claude.js`. Editalos, commit, push, y Vercel redespliega solo. Si querés probar ajustes sin esperar al cron, usá `/api/test?key=...`.

## Troubleshooting

**"El bot no responde en Telegram":**
- Verificá que el webhook esté registrado: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Mirá los logs en Vercel (dashboard → tu proyecto → Logs)

**"No me lee los eventos de Calendar":**
- Verificá que compartiste el calendar con el email del service account
- Verificá que `GOOGLE_CALENDAR_ID` sea tu email (no "primary")

**"Falla el briefing automático pero el test manual funciona":**
- Probablemente sea un problema con `CRON_SECRET` - verificá que esté seteado en Vercel

## Próximos pasos (v2)

- Agregarle memoria de preferencias (qué leads son los calientes, cuáles son cold)
- Leer el CSV de leads del Drive (`1ZZkBg8_wqizRWpXvhnQ691sk_LBGuTR9qTRVZ046QiM`)
- Detección de seguimientos vencidos ("hace 5 días que no le escribís a X")
- Integrar con Óvalo Closer (pipeline único)
