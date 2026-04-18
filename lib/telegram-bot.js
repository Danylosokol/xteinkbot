const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file";

export async function telegramApi(method, botToken, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    body: payload
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || "unknown error"}`);
  }

  return data.result;
}

export async function getFileInfo(botToken, fileId) {
  const form = new URLSearchParams();
  form.set("file_id", fileId);
  return telegramApi("getFile", botToken, form);
}

export async function downloadTelegramFile(botToken, filePath) {
  const response = await fetch(`${TELEGRAM_FILE_BASE}/bot${botToken}/${filePath}`);

  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function sendMessage(botToken, chatId, text) {
  const form = new URLSearchParams();
  form.set("chat_id", String(chatId));
  form.set("text", text);
  return telegramApi("sendMessage", botToken, form);
}

export async function editMessage(botToken, chatId, messageId, text) {
  const form = new URLSearchParams();
  form.set("chat_id", String(chatId));
  form.set("message_id", String(messageId));
  form.set("text", text);
  return telegramApi("editMessageText", botToken, form);
}

export async function sendChatAction(botToken, chatId, action) {
  const form = new URLSearchParams();
  form.set("chat_id", String(chatId));
  form.set("action", action);
  return telegramApi("sendChatAction", botToken, form);
}

export async function sendDocument(botToken, chatId, buffer, filename, caption = "") {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([buffer], { type: "application/epub+zip" }), filename);

  if (caption) {
    form.set("caption", caption);
  }

  return telegramApi("sendDocument", botToken, form);
}
