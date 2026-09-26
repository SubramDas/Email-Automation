# Telegram-Controlled Email Drafting Agent

This service accepts recipient and job details from one authorized Telegram account, renders the owner's plain-text email template, and creates a Gmail draft with the configured PDF resume attached. It never calls Gmail's send endpoint; review and sending remain manual in Gmail.

## Current status

The first end-to-end Telegram request successfully created a Gmail draft with the configured files. The owner ID, Telegram credentials, Google OAuth credentials, and selected Drive file IDs are in the ignored local `.dev.vars` file. Google Cloud project `Telegram Email Draft Agent` (`telegram-email-draft-agent`, project number `795741890232`) and required APIs have been set up. The APAC D1 database is configured in `wrangler.jsonc`, and its initial migration is applied. The deployed Worker is `https://telegram-email-drafting-agent.telegramemailagent.workers.dev`, with its Telegram webhook registered.

The app expects these required request fields:

```text
Name: Aayush
Email: aayush@example.com
Company: Example Company
Job Title: Senior Software Engineer
Job ID: 12345
```

Missing fields prompt a follow-up. Pending details expire after 24 hours. Semantic duplicate detection is intentionally omitted, so resubmitting a request may create another draft.

## Architecture

- Telegram Bot API sends updates to a Cloudflare Worker HTTPS webhook.
- The Worker checks Telegram's webhook secret token and the configured numeric owner ID.
- Cloudflare D1 stores incomplete request fields for up to 24 hours.
- Google Drive supplies the selected `.txt` template and PDF resume.
- Google Gmail API creates a draft. The application has no send operation.
- Runtime values and OAuth credentials belong in Cloudflare Worker secrets, not source control.

Google requires the `gmail.compose` OAuth scope to create drafts. Google describes that scope as permitting draft management and sending. The code must continue to call only `users.drafts.create`; it must not add or call a Gmail send method.

## Requirements

- Node.js 20 or newer and npm.
- A Telegram bot created through @BotFather.
- A Cloudflare account kept on the Workers Free plan.
- A Google Cloud project with Gmail API enabled and OAuth configured.
- A private Google Drive folder containing `email-template.txt` and a PDF resume.

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.dev.vars` and fill only development credentials there. Do not commit `.dev.vars`.
3. The remote D1 database ID is already set in `wrangler.jsonc`. Apply the schema to the local development database with `npx wrangler d1 migrations apply telegram-email-agent-state --local`.
4. Run `npm run dev` and use the local Worker URL for development.

No private resume or template file should be placed in this repository. The local `npm run google:setup` utility uses Google Picker with the narrow `drive.file` scope to select those Drive files.

## Get the owner Telegram ID

The owner's numeric ID is already configured in the ignored local `.dev.vars` file for development. For production, set `ALLOWED_TELEGRAM_USER_ID` as a Cloudflare Worker secret. If you need to retrieve it again, do so before setting a webhook by entering the bot token without echoing it, then running the helper script:

```sh
read -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN
export TELEGRAM_BOT_TOKEN
npm run telegram:owner-id
unset TELEGRAM_BOT_TOKEN
```

The bot must not already have a webhook configured because Telegram does not allow `getUpdates` polling and webhook delivery at the same time. The helper prints only the private chat sender's numeric ID. Keep that ID private and use it as `ALLOWED_TELEGRAM_USER_ID`.

## Google authorization and Drive file selection

The one-time setup runs locally so the Google refresh token never passes through Telegram or a hosted setup endpoint.

1. In Google Cloud Console, create an OAuth client with **Application type: Web application**.
2. Add this exact **Authorized redirect URI**:

   ```text
   http://127.0.0.1:8788/callback
   ```

3. Create an API key for Google Picker. Restrict **Application restrictions** to websites and add:

   ```text
   http://127.0.0.1:8788
   http://127.0.0.1:8788/*
   https://docs.google.com
   https://docs.google.com/*
   ```

   Restrict the key to the **Google Picker API** and **Google Drive API**.
4. Add these values to ignored `.dev.vars` (do not send their values in chat):

   ```text
   GOOGLE_CLIENT_ID=
   GOOGLE_CLIENT_SECRET=
   GOOGLE_API_KEY=
   GOOGLE_CLOUD_PROJECT_NUMBER=795741890232
   ```

5. Run `npm run google:setup`, open the printed local address, and authorize with the test Gmail account. Pick `email-template.txt` and then the PDF resume. The utility validates their types and writes `GOOGLE_REFRESH_TOKEN`, `DRIVE_TEMPLATE_FILE_ID`, and `DRIVE_RESUME_FILE_ID` into `.dev.vars` without printing their values.

Google OAuth apps left in Testing mode expire test-user authorizations after seven days, so repeat this setup when Google authorization expires. [Google testing-mode limits](https://support.google.com/cloud/answer/15549945?hl=en)

To renew production authorization after expiration, rerun `npm run google:setup` locally, authorize the same Gmail account, then update the Worker secrets from `.dev.vars` with `npx wrangler secret bulk .dev.vars`. The Worker will use the updated refresh token after Wrangler applies the secrets.

If Google shows `Error 403: access_denied` saying only developer-approved testers can access the app, check **Google Auth Platform → Audience → Test users** and add the exact Gmail account selected in the browser. Confirm the audience is **External** and publishing status is **Testing**. The local setup explicitly asks Google to show the account chooser.

If Google Picker displays `The API developer key is invalid`, check the `GOOGLE_API_KEY` entry (it must be an API key, not the OAuth client ID or client secret). In **APIs & Services → Credentials**, edit that API key and confirm its website restrictions include `http://127.0.0.1:8788`, `http://127.0.0.1:8788/*`, `https://docs.google.com`, and `https://docs.google.com/*`, and its API restrictions allow **Google Picker API** and **Google Drive API**. Confirm both APIs are enabled in the same Cloud project as the key and OAuth client. Google notes that Picker requires the `docs.google.com` referrer because the picker runs in an iframe there. Do not enter the OAuth callback query string (`?state=...&code=...`) as a website restriction; the OAuth redirect URI is a separate setting and must be exactly `http://127.0.0.1:8788/callback`. After saving changes, stop and rerun `npm run google:setup` so it reloads `.dev.vars`; key restriction changes can take a short time to propagate. [Google Picker API key setup](https://developers.google.com/workspace/drive/picker/guides/web-picker) · [API key referrer restrictions](https://docs.cloud.google.com/docs/authentication/api-keys)

## Cloudflare setup (after the setup flow is complete)

1. The D1 database exists and its initial migration is applied.
2. Deploy once with `npm run deploy` to create the Worker and obtain its `workers.dev` HTTPS URL. It will report not ready until secrets are added.
3. Upload the local values as encrypted Worker secrets with `npx wrangler secret bulk .dev.vars`. This also uploads the Picker API key and project number as secrets; the Worker does not use them at runtime.
4. Register the webhook with `npm run telegram:set-webhook -- https://<worker>.workers.dev`. The helper first checks `/health`, then calls Telegram `setWebhook` using the token and secret from `.dev.vars`; it does not print either value.

Do not put real tokens in shell history, source files, issues, or chat. If a token is exposed, revoke/rotate it immediately.

## Checks

- `npm run typecheck` runs TypeScript's static type checker.
- `npm run format:check` checks formatting.
- `npm run format` formats tracked project files.

## Privacy and operations

- Never log recipient data, Telegram user IDs, email bodies, resume bytes, access tokens, or refresh tokens.
- Keep Google Drive sharing set to Restricted. The application should receive access only to the files selected in its setup flow.
- If Google OAuth remains in Testing mode, Google may expire refresh tokens after seven days. Authorization renewal/publishing behavior must be settled before a long-running pilot.
- Disable the Telegram webhook and rotate Telegram/Google credentials if access is suspected to be compromised.
- Service limits and provider requirements can change; check the current Cloudflare, Telegram, and Google documentation before production use.
