# Context Snapshot: RSS XML Parse Error

**Created**: 2026-06-11T15:16:00Z
**Slug**: rss-xml-parse-error

## Task Statement
项目运行时报错，报错内容参考 err-20260611.log，请分析并提出修改方案。

## Error Summary
```
url https://nitter.privacyredirect.com/aleabitoreddit/rss
Error: Unable to parse XML.
    at /rsspush/api/node_modules/rss-parser/lib/parser.js:36:25
```

## Root Cause Analysis (from code inspection)
1. **Error Source**: `rss-parser` library throws "Unable to parse XML" when it receives non-XML content
2. **Affected URL**: `https://nitter.privacyredirect.com/aleabitoreddit/rss` (Nitter instance for Twitter RSS)
3. **Likely Cause**: The Nitter instance is returning HTML error page or non-XML response instead of valid RSS XML
4. **Error Handling Gap**: In `taskProcessor.js`, error is caught and logged, but:
   - Error still propagates to error log file
   - Task continues processing without clear user notification
   - No retry mechanism or fallback

## Codebase Touchpoints
- `taskProcessor.js` - Main task processing logic, uses `rss-parser`
- `cron.js` - Legacy cron-based processing (also uses `rss-parser`)
- `app.js` - API entry point, calls `processTask()`
- `config.yaml` - Notification configuration (DingTalk webhook)

## Technical Context
- RSS Parser: `rss-parser@^3.12.0`
- Proxy Support: Yes, via `https-proxy-agent`
- Error Log: `err-20260611.log` contains multiple "Unable to parse XML" errors

## Prompt-Safe Summary Status
not_needed - context is concise

## Unknowns
- Is the Nitter instance permanently down or temporarily unavailable?
- Should we add retry logic or just skip failed feeds?
- Should users be notified when a feed fails to parse?
- Is there a preferred fallback Nitter instance?
