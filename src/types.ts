export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ALLOWED_TELEGRAM_USER_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  DRIVE_TEMPLATE_FILE_ID?: string;
  DRIVE_RESUME_FILE_ID?: string;
}

export interface RequestDetails {
  name?: string;
  email?: string;
  company?: string;
  job_title?: string;
  job_id?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string };
  };
}
