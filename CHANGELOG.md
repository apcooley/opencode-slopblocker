# Changelog

## Unreleased

- Announce the configured rules in every system prompt, so agents know them before their first response.
- Add `onExhausted` (`stop` or `slop`, default `stop`): after the retry budget runs out, either halt with a notice or pass the content through with the override warning.
- Make the automatic retry budget configurable via `maxRetries` (default 3, was a hard-coded 1).
- State every configured rule in corrective prompts and write-tool lint errors, so agents stop failing one rule at a time.
- Restore the opt-in, stripped override prefix for individual responses and writes.
- Retry rejected responses until the retry budget is exhausted, then stop with a user-facing notice.
- Warn users when an override allows content that still violates a rule.

## 0.1.0 - 2026-08-10

- Lint final OpenCode responses.
- Block violations before file writes and edits.
- Cover Slack, Notion, and Linear write tools.
- Support configurable blocked words and em-dash enforcement.
