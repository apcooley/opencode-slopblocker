# Contributing

1. Create a focused branch.
2. Add or update tests for every changed rule, tool name, or writable field.
3. Run `bun test` and `bun run typecheck`.
4. Keep pull requests limited to one behavior change.

New MCP integrations must use explicit tool names and explicit content fields. Include tests proving that read tools and metadata are not linted.
