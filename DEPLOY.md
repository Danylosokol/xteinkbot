# Telegram EPUB Bot

## What this bot does

- accepts one `.epub` file in Telegram
- rewrites that EPUB in memory
- rotates image assets
- inserts dedicated image pages into the EPUB reading flow
- sends back one processed `.epub`

## What you need before deployment

1. A Telegram account.
2. A bot token from [@BotFather](https://t.me/BotFather).
3. A Vercel account at [vercel.com](https://vercel.com/).
4. A random secret string for webhook verification.
5. This repo pushed to GitHub.

## Step by step

### 1. Create your Telegram bot

1. Open [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Follow the prompts.
4. Copy the bot token it gives you.

### 2. Prepare your secret

Make up a random string, for example:

`my-telegram-webhook-secret-123`

You will use it as `TELEGRAM_WEBHOOK_SECRET`.

### 3. Upload the project to GitHub

1. Create a GitHub repo.
2. Push this project to it.

### 4. Import the repo into Vercel

1. Log in to Vercel.
2. Click `Add New...`
3. Choose `Project`
4. Import your GitHub repo.

### 5. Add environment variables in Vercel

In the Vercel project settings, add:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

### 6. Deploy

Deploy the project and copy the production URL, for example:

`https://your-project.vercel.app`

### 7. Register the Telegram webhook

Open this URL in your browser after replacing the placeholders:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_DOMAIN>/api/telegram&secret_token=<YOUR_WEBHOOK_SECRET>
```

Example:

```text
https://api.telegram.org/bot123456:ABCDEF/setWebhook?url=https://my-bot.vercel.app/api/telegram&secret_token=my-secret-value
```

If Telegram returns `"ok": true`, your bot is connected.

### 8. Test the bot

1. Open your bot in Telegram.
2. Send it an `.epub` file.
3. Wait for the processing message.
4. Receive the processed `.epub` back.

## Important limits

- Input EPUB should stay under `20 MB`.
- The bot returns an EPUB, not a ZIP or folder.
- No output artifacts are intentionally stored by the bot.

## Files that matter

- `api/telegram.js`: Vercel webhook endpoint
- `lib/epub-rotate-images.js`: in-memory EPUB transformer
- `lib/telegram-bot.js`: Telegram API helpers
- `scripts/`: local reference scripts from earlier experiments
