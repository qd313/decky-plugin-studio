# The in-IDE preview was retired

The in-IDE preview (the "Decky: Open Preview" command and the `preview_*` MCP tools) was
retired on 2026-10-24.

Why: its only consumer, bonsAI, removed every preview hook on 2026-10-17 (GitHub issue #6)
because the preview never mounted its panel. The `@decky/api` shim lacked
`useQuickAccessVisible` from 2026-08-08, and four other findings from that day (silent DOM
truncation, a placeholder PNG stored as a screenshot, a dead backend reported as healthy, two
workspaces sharing one preview) were never fixed. A tool that reports fiction is worse than none.

What to use instead: on-device QA through the `deck_*` tools (`deck_deploy`, `deck_openPlugin`,
`deck_readFocus`, `deck_assertFocusMove`, `deck_captureScreenshot`), plus `plugin_lintFocus` for
static checks. `.decky/preview.json` is still read for `panelRootSelector` and `preDeployCommand`;
the file name is unchanged on purpose.
