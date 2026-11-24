---
"@nanocollective/nanocoder-desktop": patch
---

Say when a message is too long before it is sent. A message over 100,000 characters used to be sent anyway, and the turn then failed with "Invalid request" and marked the thread failed. The composer now shows "message is over 100,000 characters" and keeps Send off until the draft is shorter, and the thread stays ready.
