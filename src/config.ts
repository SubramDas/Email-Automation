import type { Env } from "./types";

const REQUIRED_SETTINGS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ALLOWED_TELEGRAM_USER_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "DRIVE_TEMPLATE_FILE_ID",
  "DRIVE_RESUME_FILE_ID",
] as const;

export function missingConfiguration(env: Env): string[] {
  return REQUIRED_SETTINGS.filter((key) => !env[key]);
}
