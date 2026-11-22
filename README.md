# AI Support Ticket Triage

Express, PostgreSQL/pgvector, RabbitMQ, and Gemini support ticket triage. The API accepts a ticket immediately and workers classify it asynchronously.

## Run

You need Docker Engine with the Docker Compose plugin and internet access for the first run. You do not need Node.js, PostgreSQL, or RabbitMQ installed on the host. Compose downloads missing registry images and builds the application and pgvector-enabled PostgreSQL images.

1. Copy `.env.example` to `.env` and set the required values. Set `DATABASE_URL` to a PostgreSQL connection string using host `postgres` for Compose, and set a long `JWT_SECRET` and a changed support password.
2. Run `docker compose up -d --build`. Compose builds the application and PostgreSQL images, and downloads RabbitMQ if its image is missing locally.
3. The API runs on PORT. Compose starts one worker consuming the quorum `ticket_processing` queue. RabbitMQ applies native delayed retry when the worker returns a retryable message. The support account is seeded from SUPPORT_EMAIL and SUPPORT_PASSWORD.

RabbitMQ queue types are immutable. If an earlier run created `ticket_processing` as a classic queue, finish or recover its pending messages, then delete the empty queue before starting this version so it can be recreated as quorum.

For a no-key run, set `MODEL_PROVIDER=fake`, `MODEL_NAME=fake_v1`, and `EMBEDDING_MODEL=fake_embedding_v1`. For a lower-cost real Gemini run, set `MODEL_PROVIDER=gemini`, `MODEL_NAME=gemini-3.5-flash-lite`, `EMBEDDING_MODEL=gemini-embedding-2`, and `GEMINI_API_KEY`. `GEMINI_API_KEY` is required only in Gemini mode. Confirm the model has a nonzero quota for your project in Google AI Studio. When running the app outside Compose, set the host in `DATABASE_URL` to the address where PostgreSQL is reachable, such as `localhost`.

Run npm test and npm run build. Migrations use Sequelize CLI and the pgvector extension is bootstrapped by the PostgreSQL image. The pgvector image builds from the `postgres:16` and `pgvector/pgvector:0.8.1-pg16` base images; Compose downloads `rabbitmq:4.3.7-management` when it is missing locally.

## API

- POST /api/auth/register: first_name, last_name, email, optional phone, password. New accounts are customers.
- POST /api/auth/login: email, password. Returns an HTTP-only cookie.
- POST /api/tickets: subject, body, customer_email. Customer submissions must use the authenticated account email; support users may submit a ticket for another email. Returns 202 with ticket ID and triage_status.
- GET /api/tickets/:id: customers see only their own status; support sees the ticket and validated triage result.
- GET /api/tickets?status=&category=&priority=&page=1&limit=20: support only.

## Design

Gemini receives the ticket as JSON data under a system instruction that says ticket content is untrusted and must not change the task. The response schema restricts category and priority to the supported values and asks for a summary plus short source quotes. Joi checks the exact shape and one-sentence summary; the worker confirms each quote appears verbatim in the ticket. A second, short Gemini call acts as a judge: it checks that the category, priority, evidence, and summary are relevant and supported by the source. The judge reuses the configured model, which keeps deployment simple but can still share the generator's blind spots. Category, priority, summary, and internal confidence are persisted only after checks pass; rejected outputs are never cached or written to triage results. Prompt injection defenses reduce risk but cannot guarantee model correctness. After three invalid or rejected candidates, the ticket is marked for manual review.

A processing worker claims a pending or retry-waiting ticket in a short row-lock transaction, records processing status and attempt number, then releases the lock before calling the provider. Completion is fenced by the attempt number. Each Gemini HTTP request has a 30-second timeout and up to three SDK attempts for transient HTTP/network failures. A structurally or semantically invalid result gets up to three local generate-and-judge attempts, then the ticket is marked for manual review. Provider failures remaining after SDK retries are classified before queue retry or manual review. The quorum queue applies native linear delayed retry using a 30-second base and 120-second cap, yielding 30-, 60-, and 90-second delays for the three application retries. The processing slot is released while RabbitMQ holds the message. Retry counts and status reasons remain in PostgreSQL. Messages are persistent and consumers acknowledge after database changes.

Cache identity includes the exact subject/body text hash, model name, and prompt version. The application adds its validation-pipeline revision to the configured `PROMPT_VERSION`, so this rollout cannot reuse results produced before evidence checks and judging; bump the configured version when changing prompt instructions. Duplicate detection uses `gemini-embedding-2` with the symmetric `sentence similarity` task prefix and 1536 dimensions. This dimension is Google-recommended and fits pgvector's 2000-dimension HNSW index limit. The original create-table migration now creates the matching 1536-dimensional column. If a local database already ran the earlier 32-dimensional migration, recreate that disposable database before applying the edited initial migration. The configured 0.92 similarity threshold should be recalibrated against labeled ticket pairs before changing it. Embeddings rank similar open tickets from the same customer.

At 10,000 tickets/hour, provider throughput and rate limits, queue depth, and database connections become the first constraints. At one million/day, scale worker replicas and connection pooling, partition or archive old tickets and history, batch queue publishing, and enforce provider concurrency and cost budgets.

## Accuracy and retry policy

Provider errors are classified from the HTTP status and a small set of network error codes. HTTP 408, 429, selected 5xx responses, and recognized network failures are retryable; HTTP 402 is treated as quota exhaustion, 401/403 as configuration failures, and 400/404/422 as invalid requests. The classifier does not inspect `Retry-After` headers or Gemini `RetryInfo` details. Therefore every HTTP 429, including a zero-quota response, receives the same RabbitMQ delayed retries. RabbitMQ applies its configured 30-, 60-, and 90-second delays for the three application retries. Other failures are moved to manual review.

The `ticket_processing` quorum queue has no dead-letter exchange or dead-letter queue configured. RabbitMQ 4.x applies its default quorum delivery limit of 20; if unexpected consumer failures repeatedly cause requeue, a message that exceeds this limit can be dropped. The worker writes these failures to the Pino error log, but the application does not currently send alerts or retain exhausted messages in a dead-letter queue. Candidate and judge prompts use explicit priority rules and require an English one-sentence summary even for tickets written in another language. Results below 0.85 confidence need manual review and are not cached. Confidence remains internal.

Exact-text cache hits remain automatic. Embedding-based reuse checks same-customer tickets above a 0.92 cosine similarity starting threshold, aligned with duplicate detection. This is an operating starting point, not a calibrated accuracy guarantee: evaluate it on human-labeled ticket pairs and adjust based on classification errors and reuse coverage. The model verifies the prior category and priority in one call and generates a fresh summary; failed verification falls back to full triage. Similarity alone never copies a prior summary.

To evaluate, collect a representative JSON array of human-labeled tickets with `id`, `expectedCategory`, `expectedPriority`, `predictedCategory`, `predictedPriority`, `triageStatus`, `source`, and `englishSummaryValid`. Include all priority levels, languages, ambiguous tickets, injection attempts, and near duplicates. Run `npx ts-node src/rabbitmq/evaluation.ts path/to/labeled-results.json`. Review urgent misses and semantic reuse errors when adjusting the similarity threshold. These metrics use human labels; the model judge is not ground truth.
