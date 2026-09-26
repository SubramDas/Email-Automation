import { createDraftFromDrive } from "./google";
import { sendTelegramMessage } from "./telegram";
import type { Env, RequestDetails, TelegramUpdate } from "./types";
import { mergeDetails, parseDetails, validateDetails } from "./validation";

const STATE_TTL_SECONDS = 24 * 60 * 60;

async function loadPending(
  env: Env,
  userId: string,
): Promise<{
  chatId: string;
  details: RequestDetails;
} | null> {
  const row = await env.DB.prepare(
    "SELECT chat_id, details_json FROM conversations WHERE telegram_user_id = ? AND expires_at > ?",
  )
    .bind(userId, Math.floor(Date.now() / 1000))
    .first<{ chat_id: string; details_json: string }>();
  if (!row) return null;
  try {
    return {
      chatId: row.chat_id,
      details: JSON.parse(row.details_json) as RequestDetails,
    };
  } catch {
    return null;
  }
}

async function storePending(
  env: Env,
  userId: string,
  chatId: string,
  details: RequestDetails,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO conversations (telegram_user_id, chat_id, details_json, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       details_json = excluded.details_json,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, chatId, JSON.stringify(details), now + STATE_TTL_SECONDS, now)
    .run();
}

function missingPrompt(missing: string[]): string {
  return `Please provide ${missing.join(", ")}. You can send them like this:\n\nName: Aayush\nEmail: aayush@example.com\nCompany: Example Company\nJob Title: Senior Software Engineer\nJob ID: 12345`;
}

export async function processTelegramUpdate(
  env: Env,
  update: TelegramUpdate,
): Promise<void> {
  const message = update.message;
  const text = message?.text?.trim();
  const userId = message?.from?.id;
  const chatId = message?.chat?.id;
  if (!text || userId === undefined || chatId === undefined) return;
  if (message?.chat?.type !== "private") return;
  if (String(userId) !== env.ALLOWED_TELEGRAM_USER_ID) return;

  const userKey = String(userId);
  const chatKey = String(chatId);
  if (/^\/(cancel|restart)(@\w+)?$/i.test(text)) {
    await env.DB.prepare("DELETE FROM conversations WHERE telegram_user_id = ?")
      .bind(userKey)
      .run();
    await sendTelegramMessage(
      env,
      chatKey,
      "The pending request was cleared. Send the recipient and job details when ready.",
    );
    return;
  }

  const pending = await loadPending(env, userKey);
  const details = mergeDetails(pending?.details ?? {}, parseDetails(text));
  const missing = validateDetails(details);
  if (missing.length) {
    await storePending(env, userKey, chatKey, details);
    await sendTelegramMessage(env, chatKey, missingPrompt(missing));
    return;
  }

  await storePending(env, userKey, chatKey, details);
  let draftId: string;
  try {
    draftId = await createDraftFromDrive(env, details.email!, details);
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Draft creation failed.";
    await sendTelegramMessage(
      env,
      chatKey,
      `${messageText}\nYour request details are kept for 24 hours. Send the missing or corrected fields to retry.`,
    );
    return;
  }

  await env.DB.prepare("DELETE FROM conversations WHERE telegram_user_id = ?")
    .bind(userKey)
    .run();
  try {
    await sendTelegramMessage(
      env,
      chatKey,
      `Gmail draft created.\nTo: ${details.email}\nSubject: ${details.job_title} ${details.job_id} - ${details.company}\nDraft ID: ${draftId}\n\nPlease review the message and resume in Gmail before sending.`,
    );
  } catch {
    // A messaging failure must never trigger another Gmail draft creation.
  }
}
