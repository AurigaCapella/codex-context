---
name: context-panel
description: Open the native Codex Context floating window to inspect conversation token usage, context, and tool calls.
---

Resolve the installed plugin root two levels above this skill directory. Run its `open.ps1` using PowerShell. Pass `-ThreadId` when the user specifies a conversation ID or `$env:CODEX_THREAD_ID` contains the current conversation UUID. The default launch opens the native desktop status bar or restores its existing hidden window. Use `-Browser` only when the user requests a browser view.
