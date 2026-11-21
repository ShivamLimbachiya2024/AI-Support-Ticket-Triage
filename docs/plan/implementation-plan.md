# AI Support Ticket Triage implementation plan

## Architecture

The API stores customer tickets in PostgreSQL and immediately publishes a durable RabbitMQ message. Queue workers are selected by `APP_MODE` and `CONSUMER_TOPIC`; the processing worker handles `ticket_processing`, and the retry worker handles `ticket_retry`. Queue messages are published directly. The system has no outbox table or dispatcher.

## Database

Use auto-incrementing BIGINT IDs. Database columns and model attributes use snake_case. Application functions and local variables use camelCase. The initial users migration defines customer/support roles; registration only creates customers. Seed one support account using `SUPPORT_EMAIL` and `SUPPORT_PASSWORD`.

Tables: `users`, `tickets`, `triage_results`, `triage_cache`, `ticket_embeddings`, and `ticket_status_history`. Ticket status is represented once in `tickets.triage_status`: pending, processing, retry_wait, triaged, or manual_review. Each transition also gets an append-only history record. No `queue_outbox` table is used.

Use the existing postgres:16 image as the base and add the pgvector extension from a pinned pgvector image. Use the existing rabbitmq:4.3.7-management image. Compose starts PostgreSQL, RabbitMQ, the API, and one independently configured worker for each queue.

## RabbitMQ layout and flow

- `src/rabbitmq/enums/` owns queue and action names.
- `src/rabbitmq/schemas/` contains Joi schemas for queue messages and triage model output; `src/rabbitmq/types/` contains their shared TypeScript contracts.
- `src/rabbitmq/handlers/` has one handler module per message category.
- `src/rabbitmq/workers/` owns consumer startup and action dispatch for its configured queue.
- `src/rabbitmq/publisher.ts` exposes `sendToQueue({ queueName, action, payload, delayMs? })`, which publishes a persistent message and waits for broker confirmation.
- Ticket submission commits its ticket and initial status history, then directly publishes `process_ticket`.
- A worker claims pending tickets with a short row lock, changes status to processing, increments `processing_attempt`, commits, and only then calls the model. Completion checks the attempt counter.
- Provider outages set retry_wait, append the reason and retry count, and directly publish to `ticket_retry`. Retry delay uses exponential 30, 60, and 120-second timing in `src/utils/retry.ts`. The retry worker waits until the message's persisted availability timestamp, then requeues processing. Invalid model output is retried locally up to three times and then sent to manual review; it does not go to the retry queue.

## Triage and API

Gemini uses the Google Gen AI SDK. Fake mode runs without a paid key and returns deterministic results. Joi validates allowed categories, priorities, and summaries before any result is stored. The result cache key includes exact ticket text, model name, and prompt version. pgvector identifies sufficiently similar tickets from the same customer.

Customers can submit tickets and read only their own status. Support can read full results and filter the paginated ticket list. Joi validates request bodies; Pino logs request lifecycle and operation outcomes; final Express error middleware formats failures.

## Operations and acceptance

Configure environment values centrally and require values only when the selected mode needs them. Build the API, run Jest, run Prettier, and start the Compose stack. The README explains setup, fake/Gemini configuration, queue behavior, failure handling, prompt safety, and scaling trade-offs.
