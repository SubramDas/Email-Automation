import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const varsPath = resolve(".dev.vars");
const varsText = await readFile(varsPath, "utf8").catch(() => "");
const vars = Object.fromEntries(
  varsText
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);

const botToken = vars.TELEGRAM_BOT_TOKEN;
const webhookSecret = vars.TELEGRAM_WEBHOOK_SECRET;
const workerAddress = process.argv[2];
if (!botToken || !webhookSecret) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in .dev.vars.");
  process.exit(1);
}
if (!workerAddress) {
  console.error("Usage: npm run telegram:set-webhook -- https://<worker>.workers.dev");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET has invalid characters or length for Telegram.");
  process.exit(1);
}

let workerUrl;
try {
  workerUrl = new URL(workerAddress);
} catch {
  console.error("Worker URL is not valid.");
  process.exit(1);
}
if (workerUrl.protocol !== "https:" || workerUrl.username || workerUrl.password || workerUrl.search || workerUrl.hash) {
  console.error("Provide the HTTPS Worker base URL without credentials, query, or fragment.");
  process.exit(1);
}
workerUrl.pathname = "/health";

let health;
try {
  const response = await fetch(workerUrl);
  health = await response.json();
  if (!response.ok || health.ready !== true) {
    const missing = Array.isArray(health.missingConfiguration)
      ? health.missingConfiguration.join(", ")
      : "Worker health check failed";
    console.error(`Worker is not ready (${missing}). Confirm secrets were uploaded, then deploy again.`);
    process.exit(1);
  }
} catch {
  console.error("Could not reach the Worker health endpoint. Check the URL and deployment.");
  process.exit(1);
}

const webhookUrl = new URL("/telegram/webhook", workerUrl).toString();
const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message"],
  }),
});
const result = await telegramResponse.json().catch(() => null);
if (!telegramResponse.ok || result?.ok !== true) {
  console.error("Telegram rejected the webhook configuration. Check the URL and bot settings; no credentials were printed.");
  process.exit(1);
}
console.log("Worker is ready and Telegram webhook registration succeeded.");
console.log(`Webhook URL: ${webhookUrl}`);
