---
name: jevgrep
description: Find files for unfamiliar repository behavior before coding. Use instead of Grep when the path is unknown.
---

# Jevgrep

When Paseo Jev is enabled, call the host tool `jevgrep` instead of Grep or `rg` to find unfamiliar behavior.

## When

- You know the behavior (auth check, retry, quota, compact) but not the file.
- You need reading leads plus verbatim excerpts before editing.

Keep Grep or `rg` for an exact identifier, regex, or a path you already know.

## How

1. Call `jevgrep` with a question. Scope `root` to the code folder when you know it (`packages/server`, `crates/sim`).
2. Read the returned excerpts. They count as reading those ranges. Expand around a declaration only when the excerpt is truncated.
3. Listed paths are ranked leads, not a checklist. Fill remaining gaps with ordinary tools.
4. If the tool says Jev is not configured, or lists no files, fall back to Grep.

Do not run `jg` in the shell. Do not send source to a second Jev CLI. The Paseo daemon already holds the TypeSafe key.
