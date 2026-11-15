---
"@nanocollective/nanocoder-desktop": patch
---

Redact more secrets from Nanocoder's captured diagnostics. `Cookie` and `Set-Cookie` values, `key=` query values, headers that end in `-key` (such as `Ocp-Apim-Subscription-Key`) and the lines of a private key between its header and footer used to stay readable in the diagnostics view. They now show as `[redacted]`.
