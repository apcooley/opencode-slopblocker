# DRAFT: opencode.jsonc plugin path repoint

Status: DRAFT DOC, not applied. Nothing in this change touches the live
config; applying it is a CO publish action with its own precondition below.

## What changes

One line in `/Users/aaron.cooley/.config/opencode/opencode.jsonc`: the slop
blocker plugin path, currently line 10.

Before (current):

```
"file:///Users/aaron.cooley/source/ob-slopblocker-oblbrgj/src/index.ts",
```

After (target):

```
"file:///Users/aaron.cooley/source/opencode-slopblocker/src/index.ts",
```

The repoint moves the live plugin from the obl-brgj worktree to the main
checkout, which becomes the source of truth after the surface-scoping branch
(`obl-rim0k/surface-scoping`) lands.

## Precondition

Valid only after BOTH of these hold:

1. The CO merges the landed branch into main (the PR from
   `obl-rim0k/surface-scoping`).
2. The primary checkout `/Users/aaron.cooley/source/opencode-slopblocker` is
   updated to the merged main (its currently uncommitted working files are
   superseded by the landed commits).

Repointing before the merge would load stale plugin code from the primary
checkout and silently drop the retry and coach-file work.

## Apply steps

1. Edit line 10 of `/Users/aaron.cooley/.config/opencode/opencode.jsonc`,
   replacing the before line with the after line above. It is a single-line
   edit; nothing else in the file changes.
2. Validate the file still parses:

   ```
   python3 -m json.tool /Users/aaron.cooley/.config/opencode/opencode.jsonc > /dev/null && echo OK
   ```

   (jsonc comments: if the file carries comments, strip them first or use a
   jsonc-aware checker; the surrounding config has parsed with comments under
   opencode's own loader.)
3. Restart opencode so the plugin reloads from the new path, then confirm the
   init debug line (with `SLOPBLOCK_DEBUG_FILE` set) shows
   `headless=... blankInteractive=...` from the landed code.

## Rollback

Revert line 10 to the before line above and restart opencode; the obl-brgj
worktree remains on disk untouched at commit ad6ecb9 until you choose to
remove it.
