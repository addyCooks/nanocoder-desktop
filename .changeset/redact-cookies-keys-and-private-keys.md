---
"@nanocollective/nanocoder-desktop": patch
---

Redact more secrets from Nanocoder's captured diagnostics. `Cookie` and `Set-Cookie` values, `key=` query values, headers that end in `-key` (such as `Ocp-Apim-Subscription-Key`) `privateKey` values and the lines of a private key (including a PGP private key block) between its header and footer used to stay readable in the diagnostics view. They now show as `[redacted]`. Names such as `primary_key` and `sort-key` are left alone, and a stray mention of a key header no longer blanks the lines after it.
