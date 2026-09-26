import type { RequestDetails } from "./types";

export interface RenderedEmail {
  subject: string;
  body: string;
}

const PLACEHOLDER: Record<string, keyof RequestDetails> = {
  name: "name",
  company: "company",
  job_title: "job_title",
  job_id: "job_id",
};

export function renderTemplate(
  templateText: string,
  details: RequestDetails,
): RenderedEmail {
  const normalized = templateText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^Subject:\s*(.+)\n\s*\n([\s\S]+)$/i.exec(normalized);
  if (!match) {
    throw new Error(
      "Template must start with a Subject line, a blank line, and the message body.",
    );
  }

  const substitute = (input: string): string =>
    input.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, rawKey: string) => {
      const key = PLACEHOLDER[rawKey.toLowerCase()];
      if (!key)
        throw new Error(
          `Template contains an unsupported placeholder: ${whole}`,
        );
      const value = details[key];
      if (!value)
        throw new Error(`Template placeholder has no value: ${rawKey}`);
      return value;
    });

  const subject = substitute(match[1].trim());
  const body = substitute(match[2].trim());
  if (!subject || !body)
    throw new Error("Template subject and body must not be empty.");
  if (/[\r\n]/.test(subject))
    throw new Error("Rendered subject must be a single line.");
  if (/\{\{[^}]+\}\}/.test(subject + body)) {
    throw new Error("Rendered message contains an unresolved placeholder.");
  }

  return { subject, body };
}
