import {
  createTrackedDraftFromDrive,
  getGmailAccessToken,
  getGmailHistoryId,
  getGmailThread,
  gmailDraftExists,
  listGmailHistory,
  loadFollowupTemplate,
} from "./google";
import { renderTemplate } from "./template";
import { sendTelegramMessage } from "./telegram";
import type { Env, RequestDetails } from "./types";

const DAY = 24 * 60 * 60;
const TEST_DELAY_SECONDS = 60;
const FOLLOWUP_DELAY_DAYS: Record<number, number> = { 1: 3, 2: 5, 3: 7 };
const TRACKING_HEADER = "x-telegram-email-agent-tracking";

function testModeEnabled(env: Env): boolean {
  return /^(1|true|yes)$/i.test(env.FOLLOWUP_TEST_MODE ?? "");
}

function isReplyMessage(message: { labelIds?: string[] }): boolean {
  return (
    !message.labelIds?.includes("SENT") && !message.labelIds?.includes("DRAFT")
  );
}

interface FollowupRow {
  id: string;
  chat_id: string;
  details_json: string;
  state: string;
  current_step: number;
  thread_id: string | null;
  due_at: number | null;
  pending_draft_id: string | null;
  pending_step: number | null;
  reminder_at: number | null;
  reminder_sent_at: number | null;
}

function header(
  message: { headers: Array<{ name?: string; value?: string }> },
  name: string,
): string | undefined {
  return message.headers.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  )?.value;
}

function sentToRecipientAfter(
  messages: Awaited<ReturnType<typeof getGmailThread>>,
  recipient: string,
  createdAt: number,
): { threadId: string; sentAt: number } | undefined {
  const message = messages.find((item) => {
    const sentAt = Math.floor(Number(item.internalDate ?? 0) / 1000);
    return (
      item.labelIds?.includes("SENT") &&
      !item.labelIds.includes("DRAFT") &&
      sentAt >= createdAt &&
      header(item, "To")?.toLowerCase().includes(recipient.toLowerCase())
    );
  });
  if (!message) return undefined;
  return {
    threadId: message.threadId,
    sentAt: Math.floor(Number(message.internalDate ?? 0) / 1000),
  };
}

async function startAfterOriginalSent(
  env: Env,
  accessToken: string,
  id: string,
  threadId: string,
  sentAt: number,
  now: number,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT chat_id, state, test_mode FROM followups WHERE id = ?",
  )
    .bind(id)
    .first<{ chat_id: string; state: string; test_mode: number }>();
  if (!row || row.state !== "awaiting_original_sent") return;

  const thread = await getGmailThread(accessToken, threadId);
  const hasReply = thread.some(isReplyMessage);
  const result = await env.DB.prepare(
    `UPDATE followups SET state = ?, current_step = 0, thread_id = ?, due_at = ?,
     replied_at = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_original_sent'`,
  )
    .bind(
      hasReply ? "replied" : "active",
      threadId,
      hasReply
        ? null
        : sentAt +
          (row.test_mode ? TEST_DELAY_SECONDS : FOLLOWUP_DELAY_DAYS[1] * DAY),
      hasReply ? now : null,
      now,
      id,
    )
    .run();
  if (!result.meta.changes) return;
  await sendTelegramMessage(
    env,
    row.chat_id,
    hasReply
      ? "A reply is already present in the Gmail conversation. No follow-up drafts will be created."
      : row.test_mode
        ? "I detected that the original email was sent. Test follow-up 1 is scheduled about one minute after its send time if no reply arrives."
        : "I detected that the original email was sent. Follow-up 1 is scheduled for 3 days after its send time if no reply arrives.",
  ).catch(() => undefined);
}

async function advanceAfterFollowupSent(
  env: Env,
  id: string,
  step: number,
  sentAt: number,
  now: number,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT state, current_step, test_mode FROM followups WHERE id = ?",
  )
    .bind(id)
    .first<{ state: string; current_step: number; test_mode: number }>();
  if (!row || step !== row.current_step + 1) return;
  if (step === 3) {
    await env.DB.prepare(
      "UPDATE followups SET state = 'complete', current_step = 3, pending_draft_id = NULL, pending_step = NULL, reminder_at = NULL, reminder_sent_at = NULL, due_at = NULL, updated_at = ? WHERE id = ? AND state IN ('active', 'creation_uncertain')",
    )
      .bind(now, id)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE followups SET current_step = ?, pending_draft_id = NULL, pending_step = NULL,
     reminder_at = NULL, reminder_sent_at = NULL, due_at = ?, updated_at = ?
     WHERE id = ? AND state IN ('active', 'creation_uncertain') AND current_step = ?`,
  )
    .bind(
      step,
      sentAt +
        (row.test_mode
          ? TEST_DELAY_SECONDS
          : FOLLOWUP_DELAY_DAYS[step + 1] * DAY),
      now,
      id,
      step - 1,
    )
    .run();
}

async function reconcileSentDrafts(
  env: Env,
  accessToken: string,
  now: number,
): Promise<void> {
  const originals = await env.DB.prepare(
    `SELECT id, original_draft_id, thread_id, details_json, created_at
     FROM followups WHERE state = 'awaiting_original_sent' AND thread_id IS NOT NULL`,
  ).all<{
    id: string;
    original_draft_id: string;
    thread_id: string;
    details_json: string;
    created_at: number;
  }>();

  for (const row of originals.results ?? []) {
    if (await gmailDraftExists(accessToken, row.original_draft_id)) continue;
    const details = JSON.parse(row.details_json) as RequestDetails;
    if (!details.email) continue;
    const thread = await getGmailThread(accessToken, row.thread_id);
    const sent = sentToRecipientAfter(thread, details.email, row.created_at);
    if (sent)
      await startAfterOriginalSent(
        env,
        accessToken,
        row.id,
        sent.threadId,
        sent.sentAt,
        now,
      );
  }

  const pending = await env.DB.prepare(
    `SELECT id, pending_draft_id, pending_step, thread_id, details_json, reminder_at
     FROM followups WHERE state = 'active' AND pending_draft_id IS NOT NULL
       AND pending_step IS NOT NULL AND thread_id IS NOT NULL`,
  ).all<{
    id: string;
    pending_draft_id: string;
    pending_step: number;
    thread_id: string;
    details_json: string;
    reminder_at: number | null;
  }>();

  for (const row of pending.results ?? []) {
    if (await gmailDraftExists(accessToken, row.pending_draft_id)) continue;
    const details = JSON.parse(row.details_json) as RequestDetails;
    if (!details.email || row.reminder_at === null) continue;
    const thread = await getGmailThread(accessToken, row.thread_id);
    const sent = sentToRecipientAfter(
      thread,
      details.email,
      row.reminder_at - DAY,
    );
    if (sent)
      await advanceAfterFollowupSent(
        env,
        row.id,
        row.pending_step,
        sent.sentAt,
        now,
      );
  }
}

async function syncSentMessageByThread(
  env: Env,
  accessToken: string,
  message: { threadId: string; headers: Array<{ name?: string; value?: string }> },
  sentAt: number,
  now: number,
): Promise<void> {
  if (!message.threadId) return;
  const row = await env.DB.prepare(
    `SELECT id, state, current_step, details_json, created_at, pending_step, reminder_at
     FROM followups WHERE thread_id = ? AND state IN ('awaiting_original_sent', 'active')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(message.threadId)
    .first<{
      id: string;
      state: string;
      current_step: number;
      details_json: string;
      created_at: number;
      pending_step: number | null;
      reminder_at: number | null;
    }>();
  if (!row) return;
  const details = JSON.parse(row.details_json) as RequestDetails;
  if (
    !details.email ||
    !header(message, "To")?.toLowerCase().includes(details.email.toLowerCase())
  )
    return;

  if (
    row.state === "awaiting_original_sent" &&
    sentAt >= row.created_at
  ) {
    await startAfterOriginalSent(
      env,
      accessToken,
      row.id,
      message.threadId,
      sentAt,
      now,
    );
    return;
  }

  if (
    row.state === "active" &&
    row.pending_step === row.current_step + 1 &&
    row.reminder_at !== null &&
    sentAt >= row.reminder_at - DAY
  ) {
    await advanceAfterFollowupSent(env, row.id, row.pending_step, sentAt, now);
  }
}

async function syncSentMessages(
  env: Env,
  accessToken: string,
  now: number,
): Promise<void> {
  const saved = await env.DB.prepare(
    "SELECT history_id FROM gmail_sync WHERE singleton = 1",
  ).first<{ history_id: string }>();
  let cursor = saved?.history_id;
  if (!cursor) {
    const oldest = await env.DB.prepare(
      "SELECT history_cursor FROM followups WHERE state IN ('awaiting_original_sent', 'active', 'creating') ORDER BY created_at LIMIT 1",
    ).first<{ history_cursor: string }>();
    cursor = oldest?.history_cursor ?? (await getGmailHistoryId(accessToken));
  }

  const history = await listGmailHistory(accessToken, cursor);
  for (const message of history.messages) {
    if (isReplyMessage(message)) {
      if (message.threadId) {
        const replied = await env.DB.prepare(
          "SELECT id, chat_id FROM followups WHERE thread_id = ? AND state IN ('active', 'creating', 'blocked', 'creation_uncertain')",
        )
          .bind(message.threadId)
          .all<{ id: string; chat_id: string }>();
        for (const row of replied.results ?? []) {
          await env.DB.prepare(
            "UPDATE followups SET state = 'replied', replied_at = ?, due_at = NULL, updated_at = ? WHERE id = ? AND state IN ('active', 'creating', 'blocked', 'creation_uncertain')",
          )
            .bind(now, now, row.id)
            .run();
          await sendTelegramMessage(
            env,
            row.chat_id,
            "A reply arrived in the tracked Gmail conversation. No more follow-up drafts will be created. Any follow-up draft already in Gmail was left for you to inspect.",
          ).catch(() => undefined);
        }
      }
      continue;
    }
    if (!message.labelIds?.includes("SENT")) continue;
    const marker = header(message, TRACKING_HEADER);
    const match = marker?.match(/^([0-9a-f-]{36}):(0|1|2|3)$/i);
    const sentAt = Math.floor(
      Number(message.internalDate ?? now * 1000) / 1000,
    );
    if (!match) {
      await syncSentMessageByThread(env, accessToken, message, sentAt, now);
      continue;
    }
    const [, id, stepText] = match;
    const step = Number(stepText);
    if (step === 0) {
      await startAfterOriginalSent(
        env,
        accessToken,
        id,
        message.threadId,
        sentAt,
        now,
      );
      continue;
    }
    await advanceAfterFollowupSent(env, id, step, sentAt, now);
  }

  await reconcileSentDrafts(env, accessToken, now);
  await env.DB.prepare(
    `INSERT INTO gmail_sync (singleton, history_id, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET history_id = excluded.history_id, updated_at = excluded.updated_at`,
  )
    .bind(history.historyId, now)
    .run();
}

async function createDueDrafts(
  env: Env,
  accessToken: string,
  now: number,
): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT id, chat_id, details_json, state, current_step, thread_id, due_at,
       pending_draft_id, pending_step, reminder_at, reminder_sent_at
     FROM followups WHERE state = 'active' AND pending_draft_id IS NULL AND due_at <= ?
       AND (test_mode = 0 OR ? = 1)
     ORDER BY due_at LIMIT 4`,
  )
    .bind(now, testModeEnabled(env) ? 1 : 0)
    .all<FollowupRow>();

  for (const row of due.results ?? []) {
    const step = row.current_step + 1;
    const claimed = await env.DB.prepare(
      "UPDATE followups SET state = 'creating', updated_at = ? WHERE id = ? AND state = 'active' AND current_step = ? AND pending_draft_id IS NULL AND due_at <= ?",
    )
      .bind(now, row.id, row.current_step, now)
      .run();
    if (!claimed.meta.changes) continue;
    let createAttempted = false;
    try {
      const details = JSON.parse(row.details_json) as RequestDetails;
      const thread = await getGmailThread(accessToken, row.thread_id!);
      if (thread.some(isReplyMessage)) {
        await env.DB.prepare(
          "UPDATE followups SET state = 'replied', replied_at = ?, due_at = NULL, updated_at = ? WHERE id = ?",
        )
          .bind(now, now, row.id)
          .run();
        await sendTelegramMessage(
          env,
          row.chat_id,
          "A reply arrived before the follow-up draft was created. No further follow-ups will be created.",
        ).catch(() => undefined);
        continue;
      }
      const parent = thread.at(-1);
      const inReplyTo = parent && header(parent, "Message-ID");
      const template = await loadFollowupTemplate(env, step, accessToken);
      const rendered = renderTemplate(template, details);
      const originalSubject = header(thread[0]!, "Subject");
      const normalizeSubject = (subject: string): string =>
        subject
          .replace(/^(\s*re:\s*)+/i, "")
          .trim()
          .toLowerCase();
      if (
        !originalSubject ||
        normalizeSubject(rendered.subject) !== normalizeSubject(originalSubject)
      ) {
        throw new Error(
          "Follow-up subject must match the original email subject.",
        );
      }
      const safeInReplyTo =
        inReplyTo && /^<[^<>\r\n]+>$/.test(inReplyTo) ? inReplyTo : undefined;
      createAttempted = true;
      const draftId = await createTrackedDraftFromDrive(
        env,
        details.email!,
        rendered.subject,
        rendered.body,
        accessToken,
        {
          id: row.id,
          step,
          threadId: row.thread_id!,
          inReplyTo: safeInReplyTo,
        },
        step === 2,
      );
      const reminderAt = now + DAY;
      await env.DB.prepare(
        `UPDATE followups SET state = 'active', pending_draft_id = ?, pending_step = ?,
         reminder_at = ?, reminder_sent_at = NULL, updated_at = ? WHERE id = ? AND state = 'creating'`,
      )
        .bind(draftId, step, reminderAt, now, row.id)
        .run();
      await sendTelegramMessage(
        env,
        row.chat_id,
        `Follow-up ${step} draft created for ${details.email}. Please review and send it manually in Gmail. The next timer will start only after Gmail confirms it was sent.`,
      ).catch(() => undefined);
    } catch {
      const state = createAttempted ? "creation_uncertain" : "blocked";
      await env.DB.prepare(
        "UPDATE followups SET state = ?, updated_at = ? WHERE id = ? AND state = 'creating'",
      )
        .bind(state, now, row.id)
        .run();
      if (createAttempted) {
        await sendTelegramMessage(
          env,
          row.chat_id,
          `I could not confirm whether follow-up ${step} was created. Please check Gmail before taking any action. Automatic follow-ups for this request are paused to avoid creating a duplicate draft. If you confirm no unwanted duplicate remains, resume with /followups_retry ${row.id}.`,
        ).catch(() => undefined);
      } else {
        await sendTelegramMessage(
          env,
          row.chat_id,
          `I could not prepare follow-up ${step}. Automatic follow-ups for this request are paused; check that the template is valid and its subject matches the original email. After fixing it, send /followups_retry ${row.id}.`,
        ).catch(() => undefined);
      }
    }
  }
}

async function remindForUnsentDrafts(
  env: Env,
  accessToken: string,
  now: number,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, chat_id, pending_draft_id, pending_step FROM followups
     WHERE state = 'active' AND pending_draft_id IS NOT NULL
       AND reminder_at <= ? AND reminder_sent_at IS NULL
       AND (test_mode = 0 OR ? = 1)
     ORDER BY reminder_at LIMIT 10`,
  )
    .bind(now, testModeEnabled(env) ? 1 : 0)
    .all<
      Pick<FollowupRow, "id" | "chat_id" | "pending_draft_id" | "pending_step">
    >();
  for (const row of rows.results ?? []) {
    if (!(await gmailDraftExists(accessToken, row.pending_draft_id!))) continue;
    const claimed = await env.DB.prepare(
      "UPDATE followups SET reminder_sent_at = ?, updated_at = ? WHERE id = ? AND reminder_sent_at IS NULL AND state = 'active'",
    )
      .bind(now, now, row.id)
      .run();
    if (!claimed.meta.changes) continue;
    await sendTelegramMessage(
      env,
      row.chat_id,
      `Reminder: follow-up ${row.pending_step} is still an unsent draft in Gmail. The next follow-up timer will begin after you send it.`,
    ).catch(() => undefined);
  }
}

export async function processScheduledFollowups(env: Env): Promise<void> {
  const token = await getGmailAccessToken(env);
  const now = Math.floor(Date.now() / 1000);
  await syncSentMessages(env, token, now);
  await createDueDrafts(env, token, now);
  await remindForUnsentDrafts(env, token, now);
}
