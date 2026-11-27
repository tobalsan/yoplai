# Durable web shell browser validation

Use the isolated home, dummy email/password accounts, and real gateway and web
stack from [the E2E playbook](../docs/validation_e2e.md). Seed two visible local
agents, one dashboard, and a Main memory topic with a public message reference.
Use a local deterministic model for replies, memory, and checklist steps.

| Scenario | Check | Evidence |
| --- | --- | --- |
| Sidebar | Enable Durable as the first user. Drag an agent, then move it with Alt+Up or Alt+Down and the row menu. Reload and sign in from a second browser context to verify the same order. | Screenshot, DOM, and authenticated `GET /api/me/sidebar-order`. |
| Account scope | In the second dummy account, verify the default order, save a different order, and check the first account still has its previous order. | Redacted responses for both users. |
| Threads | Open Main, create an empty thread, send a message, and switch between tabs. Verify Main stays first. Fork a Main message from the icon next to Copy, close the thread, and reopen it from Threads. Try closing a running thread and verify the inline error. | DOM and thread/feed responses. |
| Memory | Open Memory, expand topics one at a time, follow a Main reference to its highlighted message, and open a closed thread from its summary. Check the gauge and plan. | Screenshot and DOM for panel and both jumps. |
| Dashboard | Follow Chat from the dashboard list, agent dashboard tab, and a standalone legacy dashboard. Verify Main opens with the dashboard beside it. | Link URLs and panel DOM. |
| Checklist | Send a deterministic task that produces one completed and one attention step with a note. Verify the warning and `1 of 2 done`. | Screenshot, DOM, and Main feed. |
| Narrow | At 720 px verify the sidebar folds, tabs scroll, and Memory opens over the transcript. | Screenshot with measured viewport. |
| Rollout | Turn Durable off and verify the legacy sidebar, Archive link, and legacy dashboard chat URL. | Screenshot, DOM, and dashboard response. |

Save proof under the issue workspace's `validation/` directory, excluding
cookies, credentials, and configuration.
