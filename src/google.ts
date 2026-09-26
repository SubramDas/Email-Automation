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

async function googleAccessToken(env: Env): Promise<string> {
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

export async function createGmailDraft(
  recipient: string,
  subject: string,
  body: string,
  resume: DriveAsset,
  accessToken: string,
): Promise<string> {
  const boundary = `agent_${crypto.randomUUID().replaceAll("-", "")}`;
  const attachment = base64Lines(base64(resume.bytes));
  const mime = [
    `To: ${recipient}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    `--${boundary}`,
    `Content-Type: ${resume.mimeType}; name="resume.pdf"`,
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="resume.pdf"',
    "",
    attachment,
    `--${boundary}--`,
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
      body: JSON.stringify({ message: { raw } }),
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
  const hasPdfAttachment = (parts: GmailMimePart[] | undefined): boolean =>
    (parts ?? []).some(
      (part) =>
        (part.filename === "resume.pdf" &&
          part.mimeType === "application/pdf") ||
        hasPdfAttachment(part.parts),
    );
  if (
    !to?.toLowerCase().includes(recipient.toLowerCase()) ||
    !hasPdfAttachment(payload?.parts)
  ) {
    throw new Error(
      "Gmail created a draft, but its recipient and resume attachment did not match the request. Check Gmail before retrying.",
    );
  }
  return result.id;
}

export async function createDraftFromDrive(
  env: Env,
  recipient: string,
  details: RequestDetails,
): Promise<string> {
  const { template, resume, accessToken } = await loadConfiguredAssets(env);
  const { subject, body } = renderTemplate(template, details);
  return createGmailDraft(recipient, subject, body, resume, accessToken);
}
