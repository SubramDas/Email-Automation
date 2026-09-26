# Implementation Plan: Telegram-Controlled Email Drafting Agent

This plan turns the goals in [Task.md](Task.md) into an implementation sequence. The repository contains the updated brief, architecture note, initial Cloudflare Worker scaffold, and a local Google OAuth/Picker bootstrap utility. Provider credentials and deployment setup still need to be completed before deployment.

## 1. Resolve product and deployment decisions

Before choosing provider-specific implementation details, record these decisions in a short architecture note (or the README):

- **Messaging channel:** use the Telegram Bot API. Create a bot with Telegram's official @BotFather and restrict it to the owner's Telegram numeric user ID. The Bot API is free to use.
- **Hosting:** proposed Cloudflare Workers Free and D1. Create a Cloudflare account and stay on the Free plan; this workload (about 10–50 requests/day) is small. Free quotas can change and over-quota requests may fail.
- **Application stack:** proposed TypeScript on Cloudflare Workers.
- **Template and resume configuration:** keep local backups and place the active `email-template.txt` and resume in the private Google Drive folder. Use a file picker and the narrow `drive.file` OAuth scope to grant access only to selected files; never make the folder public.
- **Preview:** no Telegram preview or pre-creation approval. Create the draft after valid details; the owner reviews and sends manually in Gmail.
- **Data retention:** proposed 24 hours for incomplete conversation state, 7 days for minimal completed request metadata, and 7 days for redacted routine logs.
- **Allowed operator identity:** one owner Telegram account, restricted by its numeric Telegram user ID (not username or message text).
- **Duplicate policy:** semantic duplicate detection is not required initially; a repeated request may create another draft.

Document selected providers, callback URLs, redirect URIs, required account setup, cost assumptions, and any provider limitations. Keep credentials out of this note.

## 2. Define the system boundaries and data flow

Document the components and trust boundaries before implementation:

1. Telegram Bot API delivers updates to the application over a webhook.
2. Webhook layer verifies Telegram's configured secret token, checks the sender's numeric user ID against the allowlist, and validates the payload. Semantic duplicate detection is out of scope initially.
3. Conversation service gathers and validates recipient details, prepares the email, and creates a draft once details are complete.
4. Template service loads the configured subject and body and applies only approved substitutions. Resume and template files are selected from the owner's private Drive using per-file access.
5. Gmail service creates a draft using the authenticated account and configured resume file.
6. Outbound messaging service reports questions, result, or recoverable error to the authorized sender.

Keep these explicit invariants in the design:

- The application has no code path that sends an email. Gmail requires `gmail.compose` for draft creation, but that scope also permits sending; enforce the no-send rule by implementing and calling only the Gmail drafts API.
- A Gmail draft is created immediately after all required details validate; the owner reviews and sends it manually in Gmail.
- No model or parser output can change the supplied recipient address.
- Only approved template fields and explicitly supplied values may be used to personalize the email.
- Repeated requests may create duplicate drafts in this initial version; document this limitation.

Create a small data-flow diagram and list data stored, purpose, retention, and access for each component.

## 3. Establish the project scaffold and local configuration

1. Create the application package using the selected stack, with separate modules for webhook handling, conversation state, template rendering, Gmail, Telegram messaging, configuration, and logging.
2. Add a README with setup, development, deployment, and account authorization instructions.
3. Add an example environment file containing variable names only (no usable secrets), such as Telegram bot token, Telegram webhook secret, allowed numeric user ID, Google OAuth configuration, D1 binding names, and selected Drive file IDs.
4. Add ignore rules for real environment files, OAuth token files, local databases, logs, and local resume/template backups.
5. Validate required configuration at startup and fail with a clear, non-secret error when a required value is missing.
6. Add a health endpoint that reports service readiness without exposing credentials, personal data, or provider responses.
7. Set up formatting, static checks, dependency pinning/lockfile, and a CI workflow appropriate to the selected runtime.

## 4. Configure the sender's template and resume

1. Define the template format as a subject line followed by a plain-text body, with the placeholder allowlist `{{name}}`, `{{company}}`, `{{job_title}}`, and `{{job_id}}`.
2. Keep the template's non-placeholder wording fixed by default. If model-assisted rewriting is used later, require it to return a candidate and validate it against policy; never let it make unreviewed factual claims.
3. Validate template configuration on startup: required subject/body, known placeholders only, no unresolved placeholders after rendering, and sensible size limits.
4. Decide whether a company-specific sentence is part of the template. If so, populate it only from user-provided facts or an explicitly maintained trusted source; do not infer or browse company claims silently.
5. Keep local copies private and store the active template and resume in a private Google Drive folder. Use Google Picker with `drive.file` so the owner grants access only to the selected files; avoid broad Drive-wide scopes.
6. Check that selected files exist, are readable, within Gmail/Telegram limits, and have allowed types before accepting requests. Never log or expose file contents.
7. Provide a documented Drive update procedure; replacing file content should preserve the selected file ID, or the owner can select the replacement file again.

## 5. Implement inbound Telegram handling

1. Implement the Telegram webhook endpoint using its secret-token header verification. Use HTTPS.
2. Reject invalid webhook secret tokens, unexpected methods/content types, oversized payloads, and malformed events.
3. Extract Telegram numeric user ID, update ID, timestamp, and text. Accept messages only from the configured owner ID; do not trust an identity supplied inside message text.
4. Validate webhook events and acknowledge provider retries correctly. Semantic duplicate suppression is not required initially; a repeated request or provider retry can create another draft.
5. Acknowledge webhooks quickly as required by the provider; queue slower Gmail or outbound operations if necessary.
6. Normalize whitespace and parse structured input. Require recipient name, syntactically plausible email address, company, job title, and job ID. Support a documented simple format, for example:

   ```text
   Name: Alex Example
   Email: alex@example.com
   Company: Example Co
   Job Title: Senior Software Engineer
   Job ID: 12345
   ```

   Natural-language extraction may be added, but the agent must echo back and confirm ambiguous or extracted values before draft creation.
7. Validate that name, company, job title, and job ID are non-empty and bounded in length, and that the email address is syntactically plausible. Avoid treating syntax validation as proof that the address exists.
8. Ask one concise follow-up for missing or ambiguous fields. Do not create a draft while required information is missing.
9. Define commands or phrases for canceling a request while details are incomplete and restarting the request. There is no approval-waiting state.

## 6. Implement conversation state

1. Choose a state store appropriate to deployment. Persist only what is needed to continue incomplete requests and report Gmail results.
2. Define explicit states such as `collecting_details`, `creating_draft`, `draft_created`, `failed`, `cancelled`, and `expired`.
3. Give incomplete requests an ID and expiration time; expire stale detail-collection state.
4. Once details are complete, render the email and immediately create the Gmail draft with the configured resume attached.
5. Support cancel/restart for incomplete requests. No approval step is used.
6. A repeated request may create another draft; document the lack of semantic duplicate detection.

## 7. Implement deterministic email composition

1. Render the configured subject and body using escaped, validated input values.
2. Support only the documented placeholder allowlist and reject malformed or unknown placeholders rather than silently deleting text.
3. Check the final rendered email for unresolved placeholders, empty subject/body, malformed header values, excessive length, and disallowed control characters.
4. Preserve the configured template wording; avoid unsupported experience, qualification, recipient, or company claims.
5. Include the recipient and subject in the Telegram success message so the owner can locate the draft.
6. If content generation with an LLM is used, keep it optional and bounded: provide only the approved template and user-supplied facts, require structured output, and reject claims unsupported by inputs.

## 8. Implement Gmail authorization and draft creation

1. Create a Google Cloud project and enable the Gmail API.
2. Configure OAuth consent and a client for the selected deployment. Use `https://www.googleapis.com/auth/gmail.compose` to create drafts; note that Google labels this scope as permitting draft management and sending. The app must implement and call only the drafts API, with no send method. For Drive files, add `https://www.googleapis.com/auth/drive.file` and Google Picker so the owner grants access only to the selected template and resume. Standard Drive API use is currently available without an extra usage charge within published quotas.
3. Complete the initial authorization using a secure owner-controlled flow. Store refresh/access tokens in a secret manager or protected persistent store, not source control, logs, or Telegram.
4. Implement token refresh and clear handling for revoked, expired, or insufficiently scoped authorization.
5. Build the Gmail draft with the confirmed recipient, subject, plain-text body (HTML only if deliberately supported and safely escaped), and configured resume attachment. Generate valid MIME content and encode it as required by the Gmail API.
6. Use the Gmail drafts API to create a draft; do not call the send API. Keep the send method absent from the application service interface where possible.
7. Enforce file-size and MIME-type limits before uploading. Treat a missing, unreadable, or invalid resume as a hard failure; do not create a draft without the required attachment.
8. Record the returned Gmail draft ID and request ID. Do not put the resume or full email body in logs.
9. Handle timeout ambiguity safely. Before retrying a create call after an uncertain response, reconcile using the stored request marker/draft metadata where feasible; if safe reconciliation is not possible, report the uncertainty and avoid an automatic second create.
10. Verify the created draft response includes the expected recipient and attachment metadata before sending a success confirmation.

## 9. Implement outbound Telegram responses

1. Use the Telegram Bot API to send concise follow-up questions, cancellation acknowledgements, and result messages.
2. Respect provider delivery and formatting limits.
3. Confirm success only after the Gmail API has confirmed draft creation and the app has recorded the returned draft ID.
4. Include the recipient and subject in the success message and explain that the draft is in Gmail and must be reviewed and sent manually.
5. For failures, provide an actionable message without secrets or raw provider/Gmail errors. Distinguish fixable input issues, reauthorization, resume problems, provider outage, and uncertain creation outcome.
6. Handle outbound-message failures with bounded retries. A resubmitted request may create another draft because semantic duplicate detection is omitted.

## 10. Security, privacy, and abuse controls

1. Verify Telegram's webhook secret token and restrict use to the authorized numeric Telegram user ID.
2. Use HTTPS in deployed environments and store secrets/tokens in Cloudflare's encrypted Worker secrets.
3. Use least-privilege Gmail OAuth; document the scope and how to revoke access.
4. Apply request size limits, rate limits, and replay protection. Do not add semantic request duplicate detection in the initial version.
5. Redact Telegram user IDs, email addresses, message bodies, OAuth data, and attachment content from routine logs. Keep diagnostic identifiers non-sensitive.
6. Restrict access to state storage and the resume file; encrypt persistent storage and backups where the chosen platform supports it.
7. Define deletion/retention behavior for completed, cancelled, and expired requests and apply it consistently to database and logs.
8. Ensure template values cannot inject email headers or alter recipients. Escape content for the selected email format.
9. Add a clear operational path to disable webhook processing and revoke Gmail credentials if the account or token is compromised.

## 11. Verification plan

Create automated unit, integration, and end-to-end checks for the following. Use mocked Telegram and Gmail APIs by default; any live-account test must use a dedicated test account and create drafts only.

### Input and conversation

- Complete request with all fields.
- Missing name, email, company, job title, or job ID; malformed email; ambiguous field extraction.
- Unapproved Telegram user ID, invalid webhook secret, malformed payload, oversized payload.
- Out-of-order event, concurrent delivery, expired request, and repeated request behavior (duplicates are currently allowed).
- Cancel/restart while collecting incomplete details; repeated requests may produce distinct drafts.

### Composition and privacy

- Correct rendering of `name`, `company`, `job_title`, and `job_id` placeholders with preserved template wording.
- Unknown/unresolved placeholders, control characters, header injection, empty fields, and long input.
- Ensure no unsupported facts appear and no private values are emitted to routine logs.
- Template or resume update and verification of the newly configured files.

### Gmail and attachment behavior

- Draft has the expected recipient, subject, body, and resume attachment.
- Missing/unreadable/oversized/unsupported resume fails before draft creation.
- Expired/revoked OAuth token and insufficient scope produce an actionable error.
- Gmail timeout/error reporting, including the possibility that a repeated request creates another draft.
- Assert the implementation never invokes Gmail send behavior.

### End-to-end and operations

- Simulate the full Telegram input → follow-up if needed → Gmail draft → Telegram confirmation path.
- Verify a draft is created after details validate and that the Gmail send API is never called.
- Verify an outbound Telegram failure does not cause a second draft.
- Verify startup configuration errors, health endpoint, logs, and recovery after service restart.

## 12. Deploy to a controlled pilot

1. Deploy to a non-production environment with a Telegram test bot, test Gmail account, test resume, and non-production OAuth client.
2. Configure webhook URLs, TLS, secrets, allowed sender, state storage, and health monitoring.
3. Walk through every verification scenario and inspect drafts manually in the test Gmail account.
4. Confirm the consent screen, requested OAuth scopes, Drive file permissions, logs, retention, and Cloudflare Free limits.
5. Run a limited owner-only pilot. Review failures and user experience before allowing any additional senders.
6. For production, use the intended owner Gmail account, re-authorize with least privilege, configure the production Telegram bot token and durable state storage, and verify a single draft end to end.
7. Document rollback: disable the webhook, revoke OAuth, rotate provider secrets, and preserve only the operational records needed to investigate an incident.

## 13. Documentation and handoff

Complete and maintain these project documents:

- `README.md`: overview, architecture, prerequisites, local setup, configuration, deployment, and troubleshooting.
- `Task.md`: product goal and acceptance criteria (already created).
- `Plan.md`: implementation sequence and verification plan (this document).
- `.env.example`: configuration names and safe example values only.
- Operator guide: template/resume update, authorization renewal, cancel/retry behavior, and disable/recovery procedure.
- Privacy and permissions note: data retained, retention period, Gmail scope, and credential revocation steps.

## Completion checklist

- [ ] Provider, stack, host, retention, and configuration choices documented.
- [ ] Scaffold, configuration validation, and health endpoint implemented.
- [ ] Private template and resume setup/update path implemented.
- [x] Secret-token-verified, allowlisted Telegram webhook implemented and registered for the single owner.
- [x] Input validation, follow-up, cancellation, expiry, and state transitions implemented.
- [x] Immediate draft creation after validation implemented; owner reviews and sends manually in Gmail.
- [x] Gmail OAuth uses the selected scopes, credentials are stored as local/Worker secrets, and the app has no send API path.
- [x] Owner reports the end-to-end request created a Gmail draft with the configured files.
- [ ] Retry/timeout failures are reported clearly; semantic duplicate detection is deferred.
- [ ] Telegram responses accurately report results and errors.
- [ ] Security, privacy, verification, and pilot steps completed.
- [ ] Setup and operating documentation completed.
