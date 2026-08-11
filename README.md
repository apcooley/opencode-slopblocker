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
      "blockedWords": ["structural", "compound", "compounds", "compounding", "substrate"]
    }]
  ]
}
```

`blockEmDash` defaults to `true`. `blockedWords` replaces the default word list and matches whole words case-insensitively; use an empty array to disable word blocking.

## Development

```bash
bun install
bun test
bun run typecheck
```

The plugin throws from `tool.execute.before`, so violating writes are blocked before the side effect occurs. Calls hidden inside shell commands cannot be inspected semantically.
