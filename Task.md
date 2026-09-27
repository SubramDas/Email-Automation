# Telegram-Controlled Email Drafting Agent

## Project goal

Build an email automation agent that I can operate through Telegram. I provide a person's name, email address, company name, job title, and job ID. The agent uses my saved email template and resume to prepare a personalized outreach email, creates a Gmail draft with my resume attached, and lets me review and send it myself.

The agent must prepare drafts only. Sending remains a manual action in Gmail after I have checked the recipient, message, and attachment.

## Intended workflow

1. I message the agent on Telegram with the recipient's name, email address, company name, job title, and job ID.
2. The agent checks that the required details are present and that the email address looks valid. If anything is missing or ambiguous, it asks me a concise follow-up question.
3. The agent fills the relevant placeholders in my saved email template using the details I provided.
4. It preserves the template's intent and tone. It must not invent experience, qualifications, company facts, or other personal claims. If a useful detail is unavailable, it leaves it out or asks me.
5. As soon as the required details are valid and the email is prepared, the agent creates a Gmail draft addressed to the supplied email, with the completed subject and body, and attaches my configured resume.
6. It confirms draft creation in Telegram and provides enough information to find the draft in Gmail. I review it in Gmail and send it myself.
7. After Gmail confirms that the original email was sent, the agent tracks the conversation for a reply. If there is no reply, it creates follow-up drafts on this schedule:
   - Follow-up 1: 3 days after the original email was sent.
   - Follow-up 2: 5 days after Follow-up 1 was actually sent.
   - Follow-up 3: 7 days after Follow-up 2 was actually sent.
8. Every follow-up is a Gmail draft for me to review and send manually. An unsent follow-up draft does not start the next timer. Only follow-up 2 includes the configured resume.
9. If a follow-up draft remains unsent for 24 hours, send one Telegram reminder. Do not repeat the reminder.
10. If a reply arrives in the tracked conversation at any time, the agent cancels all future follow-ups. Any follow-up draft that already exists stays in Gmail for me to inspect; the agent does not delete it.

## Intended work

- Define how the Telegram agent receives messages and safely associates a request with my account.
- Store and manage my email template and resume so they can be reused for each request.
- Parse recipient and job details from Telegram messages and handle missing or unclear information through follow-up questions.
- Personalize the template without changing its core meaning or making unsupported claims.
- Create a draft immediately after validating the complete request; I review and send it manually in Gmail.
- Integrate with Gmail to create drafts and attach the configured resume.
- Report success or a useful error in Telegram, without claiming a draft was created unless Gmail confirms it.
- Document setup, configuration, permissions, and operational behavior.
- Track sent original messages and follow-up messages, detect replies, and create up to three manually reviewed follow-up drafts using separate templates and the defined schedule.

## Improvements to the initial plan

- **Keep sending manual.** The agent should never send messages; Gmail remains the final review and send point.
- **Handle incomplete input explicitly.** Ask for missing details rather than guessing, especially for the recipient's email address.
- **Constrain personalization.** Use only information from my input and approved template/context; do not fabricate company research or claims about me.
- **Keep the first version simple.** Semantic duplicate detection is not required initially; a repeated request may create another draft.
- **Protect account access and files.** Use OAuth and the narrowest Gmail permissions that support draft creation, restrict access to my Telegram identity, and keep credentials and resume files out of source control and logs.
- **Make failures recoverable.** Tell me whether the draft was created, distinguish validation/authentication/attachment failures, and avoid silently creating a second draft after an uncertain result.
- **Plan for template and resume updates.** Provide a clear way to change the saved template or resume without editing application code.

## Initial acceptance criteria

- A valid Telegram request with recipient name/email, company, job title, and job ID can produce a Gmail draft with the supplied recipient, a template-based subject/body, and the configured resume attached.
- Missing or invalid required details result in a follow-up rather than a guessed draft.
- A complete valid Telegram request creates a Gmail draft with the configured resume attached, without a separate preview/approval step.
- The agent does not send email.
- The generated message does not contain unsupported personal or company claims.
- Telegram receives a truthful confirmation or actionable failure message for each request.
- An original email starts a maximum of three follow-up drafts at +3 days, then +5 and +7 days from the preceding manual sends; a reply prevents later drafts.
- Follow-up drafts remain unsent, only follow-up 2 carries the resume, and an unsent draft gets at most one Telegram reminder after 24 hours.
- Secrets and personal files are not committed to the repository or written to routine logs.

## Current implementation choices

- Telegram Bot API has been selected. Cloudflare Workers Free + D1 and TypeScript are proposed; a Cloudflare account must be created.
- Recommended file setup: keep local copies and place the active template and resume in a private Google Drive folder selected through Google Picker.
- Proposed retention: 24 hours for incomplete requests and 7 days for minimal completed metadata and redacted logs.
- Configure the Telegram bot token and owner's numeric Telegram user ID through private secrets/settings during setup.
