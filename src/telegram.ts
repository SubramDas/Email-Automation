import type { Env } from "./types";

export async function sendTelegramMessage(
  env: Env,
  chatId: string,
  text: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram is not configured.");
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );
  if (!response.ok) throw new Error("Telegram could not deliver the reply.");
}

export function secretMatches(
  expected: string,
  actual: string | null,
): boolean {
  if (!actual || expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}
