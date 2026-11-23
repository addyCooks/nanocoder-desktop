---
"@nanocollective/nanocoder-desktop": patch
---

Redact secrets, control characters and bidi overrides from the automatic thread title. The title is the start of the first prompt and is stored and listed, so a pasted token was kept in plain text. The title is also now cut on a character boundary, so an emoji at the end is no longer split into a replacement character.
