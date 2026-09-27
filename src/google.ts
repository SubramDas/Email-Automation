import type { Env } from "./types";
import { renderTemplate } from "./template";
import type { RequestDetails } from "./types";

export interface DriveAsset {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

interface GmailMimePart {
  filename?: string;
  mimeType?: string;
  parts?: GmailMimePart[];
}

export async function googleAccessToken(env: Env): Promise<string> {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error("Google authorization is not configured.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok)
    throw new Error("Google authorization expired or was revoked.");
  const result = (await response.json()) as { access_token?: string };
  if (!result.access_token)
    throw new Error("Google authorization did not return an access token.");
  return result.access_token;
}

export async function loadDriveFile(
  env: Env,
  fileId: string,
  accessToken: string,
): Promise<DriveAsset> {
  const metadataResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!metadataResponse.ok)
    throw new Error("A configured Google Drive file could not be accessed.");
  const metadata = (await metadataResponse.json()) as {
    name?: string;
    mimeType?: string;
    size?: string;
  };

  if (metadata.mimeType === "application/vnd.google-apps.document") {
    throw new Error(
      "The email template must be uploaded as a plain .txt file, not a Google Doc.",
    );
  }
  if (
    metadata.mimeType !== "application/pdf" &&
    metadata.mimeType !== "text/plain"
  ) {
    throw new Error(
      "Drive file type is not allowed. Use a .txt template and PDF resume.",
    );
  }
  const declaredSize = Number(metadata.size ?? 0);
  if (declaredSize > 20 * 1024 * 1024)
    throw new Error("Configured file exceeds the 20 MB size limit.");

  const fileResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!fileResponse.ok)
    throw new Error("A configured Google Drive file could not be downloaded.");
  const bytes = new Uint8Array(await fileResponse.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024)
    throw new Error("Configured file exceeds the 20 MB size limit.");
  return { bytes, mimeType: metadata.mimeType, name: metadata.name ?? "file" };
}

export async function loadConfiguredAssets(env: Env): Promise<{
  template: string;
  resume: DriveAsset;
  accessToken: string;
}> {
  if (!env.DRIVE_TEMPLATE_FILE_ID || !env.DRIVE_RESUME_FILE_ID) {
    throw new Error(
      "Google Drive template and resume have not been configured.",
    );
  }
  const token = await googleAccessToken(env);
  const [templateAsset, resume] = await Promise.all([
    loadDriveFile(env, env.DRIVE_TEMPLATE_FILE_ID, token),
    loadDriveFile(env, env.DRIVE_RESUME_FILE_ID, token),
  ]);
  return {
    template: new TextDecoder("utf-8", { fatal: true }).decode(
      templateAsset.bytes,
    ),
    resume,
    accessToken: token,
  };
}

export async function loadFollowupTemplate(
  env: Env,
  step: number,
  accessToken: string,
): Promise<string> {
  const fileId = [
    undefined,
    env.DRIVE_FOLLOWUP_1_FILE_ID,
    env.DRIVE_FOLLOWUP_2_FILE_ID,
    env.DRIVE_FOLLOWUP_3_FILE_ID,
  ][step];
  if (!fileId) throw new Error(`Follow-up ${step} template is not configured.`);
  const asset = await loadDriveFile(env, fileId, accessToken);
  if (asset.mimeType !== "text/plain")
    throw new Error(`Follow-up ${step} template must be a plain text file.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return btoa(binary);
}

function encodeSubject(subject: string): string {
  if (/[\r\n\u0000-\u001F\u007F]/.test(subject)) {
    throw new Error("Subject contains an invalid header character.");
  }
  return `=?UTF-8?B?${base64(new TextEncoder().encode(subject))}?=`;
}

function base64Lines(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export interface QuotedMessage {
  from: string;
  date: string;
  body: string;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function htmlToText(value: string): string {
  return (
    value
      // The agent places prior messages in blockquotes. Keep only the authored
      // portion when this sent message is reused in a later follow-up.
      .replace(/<blockquote\b[\s\S]*$/i, "")
      .replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/&#(\d+);/g, (_, code: string) =>
        String.fromCodePoint(Number(code)),
      )
      .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
        String.fromCodePoint(parseInt(code, 16)),
      )
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function quoteHeader(message: QuotedMessage): string {
  return `On ${message.date} ${message.from} wrote:`;
}

function renderHtmlQuote(quotedHistory: QuotedMessage[], index = 0): string {
  const message = quotedHistory[index];
  if (!message) return "";
  const nested = renderHtmlQuote(quotedHistory, index + 1);
  return `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><div dir="ltr" class="gmail_attr">${htmlEscape(quoteHeader(message))}</div><div>${htmlEscape(message.body).replaceAll("\n", "<br>")}</div>${nested}</blockquote>`;
}

function renderHtmlMessage(
  body: string,
  quotedHistory: QuotedMessage[],
): string {
  const current = `<div>${htmlEscape(body).replaceAll("\n", "<br>")}</div>`;
  const quoted = renderHtmlQuote(quotedHistory);
  return `<html><body>${current}${quoted}</body></html>`;
}

function renderPlainMessage(
  body: string,
  quotedHistory: QuotedMessage[],
): string {
  const renderQuote = (index: number, depth: number): string => {
    const message = quotedHistory[index];
    if (!message) return "";
    const prefix = "> ".repeat(depth + 1);
    const current = `${prefix}${quoteHeader(message)}\n\n${message.body
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n")}`;
    const nested = renderQuote(index + 1, depth + 1);
    return nested ? `${current}\n${nested}` : current;
  };
  return [body, ...(quotedHistory.length ? [renderQuote(0, 0)] : []), ""].join(
    "\n\n",
  );
}

export async function createGmailDraft(
  recipient: string,
  subject: string,
  body: string,
  resume: DriveAsset | undefined,
  accessToken: string,
  tracking?: {
    id: string;
    step: number;
    threadId?: string;
    inReplyTo?: string;
  },
  quotedHistory: QuotedMessage[] = [],
): Promise<{ draftId: string; threadId: string }> {
  const boundary = `agent_${crypto.randomUUID().replaceAll("-", "")}`;
  const alternativeBoundary = `${boundary}_alt`;
  const plainBody = renderPlainMessage(body, quotedHistory);
  const htmlBody = renderHtmlMessage(body, quotedHistory);
  const parts = [
    `To: ${recipient}`,
    `Subject: ${encodeSubject(subject)}`,
    ...(tracking
      ? [
          `X-Telegram-Email-Agent-Tracking: ${tracking.id}:${tracking.step}`,
          ...(tracking.inReplyTo
            ? [
                `In-Reply-To: ${tracking.inReplyTo}`,
                `References: ${tracking.inReplyTo}`,
              ]
            : []),
        ]
      : []),
    "MIME-Version: 1.0",
  ];
  const mime = resume
    ? [
        ...parts,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
        "",
        `--${alternativeBoundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        plainBody,
        `--${alternativeBoundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        htmlBody,
        `--${alternativeBoundary}--`,
        "",
        `--${boundary}`,
        `Content-Type: ${resume.mimeType}; name="resume.pdf"`,
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="resume.pdf"',
        "",
        base64Lines(base64(resume.bytes)),
        `--${boundary}--`,
        "",
      ].join("\r\n")
    : [
        ...parts,
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
        "",
        `--${alternativeBoundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        plainBody,
        `--${alternativeBoundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        htmlBody,
        `--${alternativeBoundary}--`,
        "",
      ].join("\r\n");

  const raw = base64(new TextEncoder().encode(mime))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          raw,
          ...(tracking?.threadId ? { threadId: tracking.threadId } : {}),
        },
      }),
    },
  );
  if (!response.ok) throw new Error("Gmail could not create the draft.");
  const result = (await response.json()) as { id?: string };
  if (!result.id) throw new Error("Gmail did not return a draft ID.");

  const verification = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(result.id)}?format=full`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!verification.ok) {
    throw new Error(
      "Gmail created a draft, but its recipient and attachment could not be verified. Check Gmail before retrying.",
    );
  }
  const draft = (await verification.json()) as {
    message?: {
      threadId?: string;
      payload?: {
        headers?: Array<{ name?: string; value?: string }>;
        parts?: GmailMimePart[];
      };
    };
  };
  const payload = draft.message?.payload;
  const to = payload?.headers?.find(
    (header) => header.name?.toLowerCase() === "to",
  )?.value;
  const trackingMarker = payload?.headers?.find(
    (header) =>
      header.name?.toLowerCase() === "x-telegram-email-agent-tracking",
  )?.value;
  const hasPdfAttachment = (parts: GmailMimePart[] | undefined): boolean =>
    (parts ?? []).some(
      (part) =>
        (part.filename === "resume.pdf" &&
          part.mimeType === "application/pdf") ||
        hasPdfAttachment(part.parts),
    );
  if (
    !to?.toLowerCase().includes(recipient.toLowerCase()) ||
    (resume && !hasPdfAttachment(payload?.parts)) ||
    (tracking && trackingMarker !== `${tracking.id}:${tracking.step}`) ||
    (tracking && !draft.message?.threadId) ||
    (tracking?.threadId && draft.message?.threadId !== tracking.threadId)
  ) {
    throw new Error(
      "Gmail created a draft, but its recipient and resume attachment did not match the request. Check Gmail before retrying.",
    );
  }
  return { draftId: result.id, threadId: draft.message!.threadId! };
}

export async function createDraftFromDrive(
  env: Env,
  recipient: string,
  details: RequestDetails,
): Promise<string> {
  const { template, resume, accessToken } = await loadConfiguredAssets(env);
  const { subject, body } = renderTemplate(template, details);
  return (await createGmailDraft(recipient, subject, body, resume, accessToken))
    .draftId;
}

export async function createTrackedOriginalDraftFromDrive(
  env: Env,
  recipient: string,
  details: RequestDetails,
  trackingId: string,
): Promise<{ draftId: string; threadId: string; historyCursor: string }> {
  const { template, resume, accessToken } = await loadConfiguredAssets(env);
  const historyCursor = await getGmailHistoryId(accessToken);
  const { subject, body } = renderTemplate(template, details);
  const draft = await createGmailDraft(
    recipient,
    subject,
    body,
    resume,
    accessToken,
    {
      id: trackingId,
      step: 0,
    },
  );
  return { ...draft, historyCursor };
}

export async function createTrackedDraftFromDrive(
  env: Env,
  recipient: string,
  subject: string,
  body: string,
  accessToken: string,
  tracking: { id: string; step: number; threadId?: string; inReplyTo?: string },
  attachResume: boolean,
  quotedHistory: QuotedMessage[] = [],
): Promise<string> {
  const resume = attachResume
    ? await loadDriveFile(env, env.DRIVE_RESUME_FILE_ID!, accessToken)
    : undefined;
  return (
    await createGmailDraft(
      recipient,
      subject,
      body,
      resume,
      accessToken,
      tracking,
      quotedHistory,
    )
  ).draftId;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  internalDate?: string;
  labelIds?: string[];
  headers: GmailHeader[];
}

export async function getGmailAccessToken(env: Env): Promise<string> {
  return googleAccessToken(env);
}

async function gmailJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) throw new Error("Gmail status could not be synchronized.");
  return (await response.json()) as T;
}

async function gmailJsonIfPresent<T>(
  path: string,
  accessToken: string,
): Promise<T | null> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Gmail status could not be synchronized.");
  return (await response.json()) as T;
}

export async function gmailDraftExists(
  accessToken: string,
  draftId: string,
): Promise<boolean> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=minimal`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Gmail draft status could not be checked.");
  return true;
}

export async function getGmailHistoryId(accessToken: string): Promise<string> {
  const result = await gmailJson<{ historyId?: string }>(
    "profile",
    accessToken,
  );
  if (!result.historyId) throw new Error("Gmail did not return a sync cursor.");
  return result.historyId;
}

export async function listGmailHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ historyId: string; messages: GmailMessageSummary[] }> {
  let pageToken: string | undefined;
  let finalHistoryId = startHistoryId;
  const ids = new Set<string>();
  do {
    const query = new URLSearchParams({
      startHistoryId,
      ...(pageToken ? { pageToken } : {}),
    });
    const result = await gmailJson<{
      historyId?: string;
      nextPageToken?: string;
      history?: Array<{
        messagesAdded?: Array<{ message?: { id?: string } }>;
        labelsAdded?: Array<{
          message?: { id?: string };
          labelIds?: string[];
        }>;
      }>;
    }>(`history?${query}`, accessToken);
    finalHistoryId = result.historyId ?? finalHistoryId;
    for (const event of result.history ?? []) {
      for (const added of event.messagesAdded ?? [])
        if (added.message?.id) ids.add(added.message.id);
      for (const labelChange of event.labelsAdded ?? [])
        if (labelChange.labelIds?.includes("SENT") && labelChange.message?.id)
          ids.add(labelChange.message.id);
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
  const fetched = await Promise.all(
    [...ids].map(async (id) => {
      const msg = await gmailJsonIfPresent<{
        id?: string;
        threadId?: string;
        internalDate?: string;
        labelIds?: string[];
        payload?: { headers?: GmailHeader[] };
      }>(
        `messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=X-Telegram-Email-Agent-Tracking`,
        accessToken,
      );
      if (!msg) return null;
      return {
        id: msg.id ?? id,
        threadId: msg.threadId ?? "",
        internalDate: msg.internalDate,
        labelIds: msg.labelIds,
        headers: msg.payload?.headers ?? [],
      };
    }),
  );
  const messages: GmailMessageSummary[] = fetched.filter(
    (message) => message !== null,
  );
  return { historyId: finalHistoryId, messages };
}

export async function getGmailThread(
  accessToken: string,
  threadId: string,
): Promise<GmailMessageSummary[]> {
  const result = await gmailJson<{
    messages?: Array<{
      id?: string;
      threadId?: string;
      internalDate?: string;
      labelIds?: string[];
      payload?: { headers?: GmailHeader[] };
    }>;
  }>(
    `threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=X-Telegram-Email-Agent-Tracking`,
    accessToken,
  );
  return (result.messages ?? []).flatMap((msg) =>
    msg.id
      ? [
          {
            id: msg.id,
            threadId: msg.threadId ?? threadId,
            internalDate: msg.internalDate,
            labelIds: msg.labelIds,
            headers: msg.payload?.headers ?? [],
          },
        ]
      : [],
  );
}

export async function getSentThreadHistory(
  accessToken: string,
  threadId: string,
): Promise<QuotedMessage[]> {
  interface Part {
    mimeType?: string;
    body?: { data?: string };
    parts?: Part[];
  }
  const result = await gmailJson<{
    messages?: Array<{
      internalDate?: string;
      labelIds?: string[];
      payload?: {
        headers?: GmailHeader[];
        mimeType?: string;
        body?: { data?: string };
        parts?: Part[];
      };
    }>;
  }>(`threads/${encodeURIComponent(threadId)}?format=full`, accessToken);
  const sent = (result.messages ?? [])
    .filter((message) => message.labelIds?.includes("SENT"))
    .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0));
  return sent.flatMap((message) => {
    const payload = message.payload;
    if (!payload) return [];
    const parts: Part[] = [];
    const collect = (part: Part): void => {
      if (part.parts?.length) part.parts.forEach(collect);
      else parts.push(part);
    };
    collect(payload);
    const htmlPart = parts.find(
      (part) => part.mimeType === "text/html" && part.body?.data,
    );
    const plainPart = parts.find(
      (part) => part.mimeType === "text/plain" && part.body?.data,
    );
    const encodedBody =
      htmlPart?.body?.data ?? plainPart?.body?.data ?? payload.body?.data;
    if (!encodedBody) return [];
    const decodedBody = decodeBase64Url(encodedBody);
    const body = htmlPart ? htmlToText(decodedBody) : decodedBody.trim();
    if (!body) return [];
    const headers = payload.headers ?? [];
    const getHeader = (name: string): string =>
      headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";
    const from = getHeader("From");
    const rawDate = getHeader("Date");
    const parsedDate = rawDate
      ? new Date(rawDate)
      : new Date(Number(message.internalDate ?? 0));
    const date = Number.isNaN(parsedDate.getTime())
      ? rawDate
      : gmailStyleDate(parsedDate);
    const displayFrom = from.replace(
      /^\s*"?([^"<>]+?)"?\s*<([^<>]+)>\s*$/,
      "$1, <$2>",
    );
    return [{ from: displayFrom || "Unknown sender", date, body }];
  });
}

function gmailStyleDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("day")} ${part("month")}, ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()}`;
}
