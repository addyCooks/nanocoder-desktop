---
"@nanocollective/nanocoder-desktop": patch
---

Redact secrets and remove control, zero-width and bidi characters from thread titles. The automatic title is the start of the first prompt and is stored and listed, so a pasted token was kept in plain text. A title that Nanocoder sends, or that comes with an imported session, gets the same cleaning. The automatic title is also now cut on a character boundary, so an emoji at the end is no longer split into a replacement character.
