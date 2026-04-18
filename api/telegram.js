import { transformEpubBuffer } from "../lib/epub-rotate-images.js";
import { downloadTelegramFile, getFileInfo, sendDocument, sendMessage } from "../lib/telegram-bot.js";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!botToken || !webhookSecret) {
      res.status(500).json({ ok: false, error: "Missing bot configuration" });
      return;
    }

    if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
      res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }

    const update = req.body;
    const message = update?.message ?? update?.edited_message;
    const document = message?.document;
    const chatId = message?.chat?.id;

    res.status(200).json({ ok: true });

    if (!chatId) {
      return;
    }

    if (!document) {
      await sendMessage(
        botToken,
        chatId,
        "Send me an EPUB file and I will return a new EPUB with rotated image pages."
      );
      return;
    }

    if (!/\.epub$/i.test(document.file_name || "")) {
      await sendMessage(botToken, chatId, "Please send a file with the .epub extension.");
      return;
    }

    if ((document.file_size || 0) > MAX_INPUT_BYTES) {
      await sendMessage(
        botToken,
        chatId,
        "That EPUB is too large for this bot. Please keep it under 20 MB."
      );
      return;
    }

    await sendMessage(botToken, chatId, "Processing your EPUB. This can take a little while.");

    const fileInfo = await getFileInfo(botToken, document.file_id);
    const inputBuffer = await downloadTelegramFile(botToken, fileInfo.file_path);
    const outputBuffer = await transformEpubBuffer(inputBuffer);
    const outputName = buildOutputName(document.file_name || "book.epub");

    await sendDocument(
      botToken,
      chatId,
      outputBuffer,
      outputName,
      "Done. Here is your processed EPUB."
    );
  } catch (error) {
    console.error(error);

    const chatId = req.body?.message?.chat?.id ?? req.body?.edited_message?.chat?.id;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (chatId && botToken) {
      try {
        await sendMessage(
          botToken,
          chatId,
          "Something went wrong while processing the EPUB. Check the deployment logs for details."
        );
      } catch (sendError) {
        console.error(sendError);
      }
    }
  }
}

function buildOutputName(inputName) {
  const suffix = ".epub";
  const base = inputName.toLowerCase().endsWith(suffix)
    ? inputName.slice(0, -suffix.length)
    : inputName;
  return `${base}.rotated-images.epub`;
}
