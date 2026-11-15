---
"@nanocollective/nanocoder-desktop": patch
---

Redact the home directory from Nanocoder's captured diagnostics however a Windows path is spelled. Paths printed with doubled backslashes, with forward slashes, inside JSON or as `file:///` addresses used to keep the user name, and the same gap hid the startup record (process ID and project folder) from the diagnostics view. Every spelling now becomes `~`.
