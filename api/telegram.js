import { transformEpubBuffer } from "../lib/epub-rotate-images.js";
import {
  downloadTelegramFile,
  editMessage,
  getFileInfo,
  sendChatAction,
  sendDocument,
  sendMessage
} from "../lib/telegram-bot.js";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export default async function handler(req, res) {
  const startedAt = Date.now();
  const requestId = req.headers["x-vercel-id"] || `local-${Date.now()}`;

  try {
    if (req.method === "GET") {
      console.log(`[telegram][${requestId}] healthcheck`);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method !== "POST") {
      console.warn(`[telegram][${requestId}] unsupported method ${req.method}`);
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (!botToken || !webhookSecret) {
      console.error(`[telegram][${requestId}] missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET`);
      res.status(500).json({ ok: false, error: "Missing bot configuration" });
      return;
    }

    if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
      console.warn(`[telegram][${requestId}] invalid webhook secret`);
      res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }

    const update = req.body;
    const message = update?.message ?? update?.edited_message;
    const document = message?.document;
    const chatId = message?.chat?.id;
    const updateId = update?.update_id;
    const filename = document?.file_name || null;

    console.log(
      `[telegram][${requestId}] update=${updateId} chat=${chatId || "none"} file=${filename || "none"}`
    );

    if (!chatId) {
      console.log(`[telegram][${requestId}] no chat id, finishing`);
      res.status(200).json({ ok: true });
      return;
    }

    if (!document) {
      console.log(`[telegram][${requestId}] no document, sending help message`);
      await sendMessage(
        botToken,
        chatId,
        "Bot is working. Send me an EPUB file and I will return a new EPUB with rotated image pages."
      );
      res.status(200).json({ ok: true });
      return;
    }

    if (!/\.epub$/i.test(document.file_name || "")) {
      console.log(`[telegram][${requestId}] rejected non-epub file ${document.file_name || "unknown"}`);
      await sendMessage(botToken, chatId, "Please send a file with the .epub extension.");
      res.status(200).json({ ok: true });
      return;
    }

    if ((document.file_size || 0) > MAX_INPUT_BYTES) {
      console.log(
        `[telegram][${requestId}] rejected file ${document.file_name || "unknown"} size=${document.file_size || 0}`
      );
      await sendMessage(
        botToken,
        chatId,
        "That EPUB is too large for this bot. Please keep it under 20 MB."
      );
      res.status(200).json({ ok: true });
      return;
    }

    console.log(
      `[telegram][${requestId}] accepted file ${document.file_name} size=${document.file_size || 0}`
    );

    const statusMessage = await sendMessage(
      botToken,
      chatId,
      [
        "Processing started.",
        "1/4 Validating the file",
        `File: ${document.file_name}`
      ].join("\n")
    );

    await sendChatAction(botToken, chatId, "upload_document");

    console.log(`[telegram][${requestId}] requesting file info`);
    await editStatus(botToken, chatId, statusMessage.message_id, [
      "Processing started.",
      "2/4 Downloading the EPUB from Telegram",
      `File: ${document.file_name}`
    ]);

    const fileInfo = await getFileInfo(botToken, document.file_id);
    console.log(`[telegram][${requestId}] file path ${fileInfo.file_path}`);
    const inputBuffer = await downloadTelegramFile(botToken, fileInfo.file_path);

    console.log(`[telegram][${requestId}] downloaded ${inputBuffer.length} bytes`);
    await editStatus(botToken, chatId, statusMessage.message_id, [
      "Processing started.",
      "3/4 Rewriting the EPUB",
      `File: ${document.file_name}`
    ]);

    const outputBuffer = await transformEpubBuffer(inputBuffer);
    const outputName = buildOutputName(document.file_name || "book.epub");

    console.log(
      `[telegram][${requestId}] transformed epub input=${inputBuffer.length} output=${outputBuffer.length}`
    );
    await sendChatAction(botToken, chatId, "upload_document");
    await editStatus(botToken, chatId, statusMessage.message_id, [
      "Processing started.",
      "4/4 Uploading the processed EPUB",
      `Output: ${outputName}`
    ]);

    await sendDocument(
      botToken,
      chatId,
      outputBuffer,
      outputName,
      "Done. Here is your processed EPUB."
    );

    await editStatus(botToken, chatId, statusMessage.message_id, [
      "Processing complete.",
      `Input: ${document.file_name}`,
      `Output: ${outputName}`,
      `Time: ${Date.now() - startedAt} ms`
    ]);
    console.log(`[telegram][${requestId}] done in ${Date.now() - startedAt}ms`);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[telegram][${requestId}] failed`, error);

    const chatId = req.body?.message?.chat?.id ?? req.body?.edited_message?.chat?.id;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (chatId && botToken) {
      try {
        await sendMessage(
          botToken,
          chatId,
          [
            "Processing failed.",
            "The bot hit an error while handling this EPUB.",
            "Check the Vercel logs for the request details."
          ].join("\n")
        );
      } catch (sendError) {
        console.error(`[telegram][${requestId}] failed to send error message`, sendError);
      }
    }

    res.status(500).json({ ok: false });
  }
}

async function editStatus(botToken, chatId, messageId, lines) {
  return editMessage(botToken, chatId, messageId, lines.join("\n"));
}

function buildOutputName(inputName) {
  const suffix = ".epub";
  const base = inputName.toLowerCase().endsWith(suffix)
    ? inputName.slice(0, -suffix.length)
    : inputName;
  return `${base}.rotated-images.epub`;
}
