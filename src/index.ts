import { missingConfiguration } from "./config";
import { processTelegramUpdate } from "./conversation";
import type { Env, TelegramUpdate } from "./types";
import { secretMatches } from "./telegram";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const missing = missingConfiguration(env);
      return Response.json(
        { ready: missing.length === 0, missingConfiguration: missing },
        { status: missing.length === 0 ? 200 : 503 },
      );
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (!env.TELEGRAM_WEBHOOK_SECRET)
        return new Response("Not configured", { status: 503 });
      const token = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secretMatches(env.TELEGRAM_WEBHOOK_SECRET, token))
        return new Response("Forbidden", { status: 403 });
      if (!request.headers.get("content-type")?.includes("application/json")) {
        return new Response("Unsupported media type", { status: 415 });
      }
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) {
        return new Response("Payload too large", { status: 413 });
      }

      let update: TelegramUpdate;
      try {
        update = JSON.parse(raw) as TelegramUpdate;
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      ctx.waitUntil(
        processTelegramUpdate(env, update).catch(() => {
          // Do not log message bodies, user IDs, credentials, or provider responses.
        }),
      );
      return new Response("ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env): Promise<void> {
    await env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?")
      .bind(Math.floor(Date.now() / 1000))
      .run();
  },
};

export default worker;
