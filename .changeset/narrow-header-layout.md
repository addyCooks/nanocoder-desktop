---
"@nanocollective/nanocoder-desktop": patch
---

Keep the thread title readable in a narrow window. At the smallest window width the header actions left the title about 26px, so the title disappeared and the "more" button was drawn over the status badge. Below 780px the actions now move to their own row under the title, and wider windows look the same as before.
