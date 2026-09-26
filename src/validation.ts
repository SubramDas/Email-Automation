import type { RequestDetails } from "./types";

const FIELD_KEYS: Record<string, keyof RequestDetails> = {
  name: "name",
  email: "email",
  company: "company",
  "job title": "job_title",
  job_title: "job_title",
  "job id": "job_id",
  job_id: "job_id",
};

const MAX_FIELD_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function parseDetails(text: string): RequestDetails {
  const details: RequestDetails = {};

  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;

    const label = line.slice(0, separator).trim().toLowerCase();
    const key = FIELD_KEYS[label];
    if (!key) continue;

    const value = line.slice(separator + 1).trim();
    if (value) details[key] = value;
  }

  return details;
}

export function mergeDetails(
  previous: RequestDetails,
  incoming: RequestDetails,
): RequestDetails {
  const merged = { ...previous };
  for (const key of Object.keys(incoming) as (keyof RequestDetails)[]) {
    if (incoming[key]) Object.assign(merged, { [key]: incoming[key] });
  }
  return merged;
}

export function validateDetails(details: RequestDetails): string[] {
  const missing: string[] = [];
  const required: Array<[keyof RequestDetails, string]> = [
    ["name", "Name"],
    ["email", "Email"],
    ["company", "Company"],
    ["job_title", "Job Title"],
    ["job_id", "Job ID"],
  ];

  for (const [key, label] of required) {
    const value = details[key]?.trim();
    if (!value) {
      missing.push(label);
      continue;
    }
    if (value.length > MAX_FIELD_LENGTH) {
      missing.push(
        `${label} (please keep it under ${MAX_FIELD_LENGTH} characters)`,
      );
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
      missing.push(`${label} (unsupported control character)`);
    }
  }

  if (details.email && !EMAIL_PATTERN.test(details.email.trim())) {
    missing.push("a valid Email address");
  }

  return [...new Set(missing)];
}
