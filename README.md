# UsagEX collector

Claude Code plugin that feeds the [UsagEX](https://usagex.dijitalpi.com) mobile app
with your usage data — **your OAuth token never leaves your machine**; only usage
percentages and token statistics are sent.

## Install

In Claude Code:

```
/plugin marketplace add dijitalpi/usagex-collector
/plugin install usagex
```

Then pair with your phone (UsagEX app → Settings → Connect a computer):

```
/usagex-connect <8-char-code>
```

That's it — the collector auto-backfills your last 30 days and keeps reporting
as you use Claude Code.

## What it sends
- Session (5-hour) and weekly limit percentages
- Per-session token/model statistics and estimated cost
- Never: your OAuth token, credentials, or conversation content

## Disable
Set `"enabled": false` in `~/.claude/usagex.json` (or delete the file).

---
UsagEX is an independent tool, not affiliated with Anthropic.
