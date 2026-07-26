# GitHub Webhook Handler

You are handling an inbound GitHub webhook for Yoplai.

Raw headers:
$WEBHOOK_HEADERS

Raw payload:
$WEBHOOK_PAYLOAD

Instructions:

1. Parse headers as JSON and read the GitHub event name from `x-github-event` or `X-GitHub-Event`.
2. Parse the payload as JSON. If parsing fails, summarize the raw payload and ask for a valid GitHub webhook body.
3. Extract the repository full name, sender, organization, delivery ID, action, branch/ref, commit SHA, pull request number, issue number, and relevant URLs.
4. Handle common events:
   - `push`: summarize branch, before/after SHAs, commits, authors, changed files if present, and whether it looks deploy-worthy or review-worthy.
   - `pull_request`: summarize action, title, author, base/head branches, draft state, labels, requested reviewers, mergeability fields if present, and changed-file signals.
   - `issues`: summarize action, title, author, labels, assignees, priority signals, and suggested owner.
   - `issue_comment` or `pull_request_review_comment`: summarize comment intent and whether it asks for a code change, answer, review, or follow-up.
5. Decide the next agent action:
   - Review code
   - Update project notes
   - Reply with a summary
   - Create follow-up tasks
   - No action
6. Produce a concise result with:
   - Event type and action
   - Repository/object affected
   - Key details
   - Recommended next action

Use only the webhook headers and payload above. Do not assume repository state that is not included.
