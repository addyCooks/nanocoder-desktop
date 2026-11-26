---
"@nanocollective/nanocoder-desktop": patch
---

Keep the sidebar footer inside the sidebar. When the agent was stopped or not started, the footer was wider than the sidebar at window widths of 900px and below, so the sidebar scrolled sideways, the runtime details and keyboard shortcuts buttons were clipped, and the keyboard shortcuts button was covered by the conversation at 700px and below. The footer now shrinks to the sidebar, and its status line is cut with an ellipsis.
