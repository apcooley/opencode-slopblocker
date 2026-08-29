# opencode-slopblocker

An OpenCode plugin that blocks configured style violations before they reach final responses, files, or supported MCP/API write tools.

Built-in write coverage includes `write`, `edit`, `apply_patch`, Slack messages and replies, Notion page/database/comment writes, and Linear create/update/comment operations. Read tools, identifiers, URLs, reactions, and other metadata are ignored.

## Install

Clone the repository:

```bash
git clone https://github.com/apcooley/opencode-slopblocker.git
```

Add the local plugin to your OpenCode configuration, replacing the path with the clone location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-slopblocker/src/index.ts"]
}
```

Restart OpenCode after changing plugin configuration.

## Defaults

The included rules reject em dashes and the words `structural`, `compound`, `compounds`, `compounding`, and `substrate`.

## Configure

Set personal rules in the plugin tuple in `opencode.jsonc`:

```jsonc
{
  "plugin": [
    ["file:///absolute/path/to/opencode-slopblocker/src/index.ts", {
      "blockEmDash": true,
      "allowOverride": false,
      "maxRetries": 3,
      "blockedWords": ["structural", "compound", "compounds", "compounding", "substrate"]
    }]
  ]
}
```

`blockEmDash` defaults to `true`. `blockedWords` replaces the default word list and matches whole words case-insensitively; use an empty array to disable word blocking. `maxRetries` defaults to `3` and must be a non-negative integer.

Set `allowOverride` to `true` to bypass all rules for one response or write. Prefix the affected content with `$SLOPBLOCK_OVERRIDE=TRUE` and a newline. The plugin removes the prefix before returning the response or executing the write. If the remaining content violates a rule, response overrides include a warning and write overrides show a warning toast. Overrides are rejected when the option is disabled, which is the default.

Rejected responses get up to `maxRetries` automatic rewrite attempts (default 3). A clean rewrite or an enabled explicit override is returned; once the budget is exhausted, the plugin stops and shows the user a notice instead of retrying again. Each corrective prompt sent to the agent states every configured rule up front ("YOUR RESPONSE WILL BE REJECTED IF IT CONTAINS ANY OF THE FOLLOWING:") so a retry does not fail on a different rule, and write-tool lint errors include the same list. Session compaction summaries are exempt from response linting.

## Development

```bash
bun install
bun test
bun run typecheck
```

The plugin throws from `tool.execute.before`, so violating writes are blocked before the side effect occurs. Calls hidden inside shell commands cannot be inspected semantically.
