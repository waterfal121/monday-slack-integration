# monday-slack-integration

This project is a **proof-of-concept (PoC)** integration between [Slack](https://slack.com) and [Monday.com](https://monday.com), aiming to achieve two-way synchronization via Webhooks and API calls.

## 🚀 Features

### 1. Slack → Monday

- When a **Slack bot** receives messages triggered by Monday updates (via Event Subscription),
- The integration **parses board and item information** from the Slack message,
- Then it uses **Monday GraphQL API** to locate the corresponding item in the target board and **create an update** there.

> ✅ Slack Bot message format is expected to include:
>
> ```
> [Bot] updated <Item Name> on <Board Name> board
> ```

### 2. Monday → Slack

- When a **Monday board column value is updated**, a **webhook** triggers a POST to this app.
- The app queries the changed item, column title, and value, and then:
  - Finds the matching item and column in the target board
  - Writes the same value to the corresponding field

> Supports:
>
> - Normal value copy
> - Clearing values via empty string or `{}` for different column types

---

## 🧩 Architecture

- Node.js with Express
- Slack Events API via `@slack/events-api`
- Monday GraphQL API
- Webhook-based event-driven design
