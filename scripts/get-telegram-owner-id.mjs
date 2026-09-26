const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in the environment, then run this script again.");
  process.exit(1);
}

let offset;
console.log("Waiting for a private message to your bot. Send /start if you have not already.");
console.log("This prints only the sender's numeric Telegram ID. Press Ctrl+C to stop.");

while (true) {
  const params = new URLSearchParams({ timeout: "25" });
  if (offset !== undefined) params.set("offset", String(offset));
  const response = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`,
  );
  if (!response.ok) {
    console.error("Telegram getUpdates failed. Check the token and ensure a webhook is not already set.");
    process.exit(1);
  }

  const result = await response.json();
  if (!result.ok || !Array.isArray(result.result)) {
    console.error("Telegram returned an unexpected update response.");
    process.exit(1);
  }

  for (const update of result.result) {
    offset = update.update_id + 1;
    const message = update.message;
    if (message?.chat?.type === "private" && message.from?.id !== undefined) {
      console.log(`Owner numeric Telegram user ID: ${message.from.id}`);
      process.exit(0);
    }
  }
}
