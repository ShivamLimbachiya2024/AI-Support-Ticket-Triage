# AI Support Ticket Triage

Express, PostgreSQL/pgvector, RabbitMQ, and Gemini support ticket triage. The API accepts a ticket immediately and workers classify it asynchronously.

## Run

You need Docker Engine with the Docker Compose plugin and internet access for the first run. You do not need Node.js, PostgreSQL, or RabbitMQ installed on the host. Compose downloads missing registry images and builds the application and pgvector-enabled PostgreSQL images.

1. Copy `.env.example` to `.env` and set the required values. Set `DATABASE_URL` to a PostgreSQL connection string using host `postgres` for Compose, and set a long `JWT_SECRET` and a changed support password.
2. Run `docker compose up -d --build`. Compose builds the application and PostgreSQL images, and downloads RabbitMQ if its image is missing locally.
3. The API runs on PORT. Compose starts one worker consuming the quorum `ticket_processing` queue. RabbitMQ applies native delayed retry when the worker returns a retryable message. The API and worker also relay committed ticket events from the database outbox. The support account is seeded from SUPPORT_EMAIL and SUPPORT_PASSWORD.

RabbitMQ queue types and declaration arguments are immutable. Before upgrading an existing `ticket_processing` queue, let ready, unacknowledged, and delayed messages finish or recover them deliberately, then delete the empty queue so this version can recreate it with the current delayed-retry settings.

When connecting to an externally managed broker, use RabbitMQ 4.3 or later. Compose uses RabbitMQ 4.3.7.

Compose runs a single RabbitMQ node. Its quorum queue is durable on the mounted volume but does not provide node-level failover; use a multi-node RabbitMQ cluster for that.

For a no-key run, set `MODEL_PROVIDER=fake`, `MODEL_NAME=fake_v1`, and `EMBEDDING_MODEL=fake_embedding_v1`. For a lower-cost real Gemini run, set `MODEL_PROVIDER=gemini`, `MODEL_NAME=gemini-3.5-flash-lite`, `EMBEDDING_MODEL=gemini-embedding-2`, and `GEMINI_API_KEY`. `GEMINI_API_KEY` is required only in Gemini mode. Confirm the model has a nonzero quota for your project in Google AI Studio. When running the app outside Compose, set the host in `DATABASE_URL` to the address where PostgreSQL is reachable, such as `localhost`.

Run npm test and npm run build. Migrations use Sequelize CLI and the pgvector extension is bootstrapped by the PostgreSQL image. Compose builds the PostgreSQL image as `postgres-pgvector:16` from the `postgres:16` and `pgvector/pgvector:0.8.1-pg16` base images; it downloads `rabbitmq:4.3.7-management` when it is missing locally.

## API

Every API response uses the shared envelope `{ data, message, toast, response_type }`. Successful responses use `response_type: "success"`; error responses use `response_type: "error"`. HTTP status codes continue to indicate the result.

- POST /api/auth/register: first_name, last_name, email, optional phone, password. New accounts are customers.
- POST /api/auth/login: email, password. Returns an HTTP-only cookie.
- POST /api/tickets: subject, body, customer_email. Customer submissions must use the authenticated account email; support users may submit a ticket for another email. The `data` value contains the ticket ID and `triage_status`.
- GET /api/tickets/:id returns status to the owning customer. Support also sees the ticket, triage result, and `canRetryClassification` inside `data`.
- GET /api/tickets?status=&category=&priority=&page=1&limit=20 lists tickets for support inside `data` and includes `canRetryClassification` on each item.
- POST /api/tickets/:id/retry-classification takes no request body. Support retries a Gemini connection failure after its automatic retry budget is exhausted. The `data` value contains the ticket ID and pending status after the retry event is committed to the database outbox. Scheduled automatic retries are ineligible for manual retry. The API returns `409` if the ticket is no longer eligible and `503` if Gemini is unavailable.

## Design

Gemini receives the ticket as JSON data under a system instruction that says ticket content is untrusted and must not change the task. The response schema restricts category and priority to the supported values and asks for a summary plus short source quotes. Joi checks the exact shape and one-sentence summary; the worker confirms each quote appears verbatim in the ticket. A second, short Gemini call acts as a judge: it checks that the category, priority, evidence, and summary are relevant and supported by the source. The judge reuses the configured model, which keeps deployment simple but can still share the generator's blind spots. Category, priority, summary, and internal confidence are persisted only after checks pass; rejected outputs are never cached or written to triage results. Prompt injection defenses reduce risk but cannot guarantee model correctness. After three invalid or rejected candidates, the ticket is marked for manual review.

A processing worker claims a pending or retry-waiting ticket in a short row-lock transaction, records processing status and attempt number, then releases the lock before calling the provider. A scheduled Gemini connection retry remains visible as `manual_review` while RabbitMQ delays it; the worker claims only that marked state under the same row lock and changes it to `processing` before inference. This keeps support retries disabled during the delay and makes duplicate deliveries skip once a worker has claimed the ticket. Completion is fenced by the attempt number. Each Gemini HTTP request has a 30-second timeout and up to three SDK attempts for errors eligible under the SDK policy. A structurally or semantically invalid result gets up to three local generate-and-judge attempts, then the ticket is marked for manual review. Provider failures remaining after SDK retries are classified before queue retry or manual review. Retryable HTTP failures and recognized timeouts or transient transport failures get up to three delayed application retries. The processing slot is released while RabbitMQ holds the message. Retry counts and status reasons remain in PostgreSQL. Messages are persistent and consumers acknowledge after database changes.

Ticket creation, support retries, and stale-ticket recovery write a ticket event to `ticket_processing_outbox` in the same database transaction as the ticket update. The API and worker relay confirmed messages from that table and remove each event after RabbitMQ confirms it. A restart between broker confirmation and database deletion can cause a duplicate message; the worker’s ticket status and attempt checks make those deliveries safe to acknowledge.

The outbox migration also queues existing `pending` tickets once, so an upgrade recovers pending work from before the outbox was introduced.

Cache identity includes the exact subject/body text hash, model name, and prompt version. The application adds its validation-pipeline revision to the configured `PROMPT_VERSION`, so this rollout cannot reuse results produced before evidence checks and judging; bump the configured version when changing prompt instructions. Duplicate detection uses `gemini-embedding-2` with the symmetric `sentence similarity` task prefix and 1536 dimensions. This dimension is Google-recommended and fits pgvector's 2000-dimension HNSW index limit. The initial create-table migration now creates the matching 1536-dimensional column. A database that already applied the earlier 32-dimensional migration has an older schema; Sequelize will not rerun an edited migration file. This is a schema version issue, not malformed or incompatible ticket data. For a disposable local database, recreate it before running migrations. For a database whose data must be kept, use a forward migration to replace the old embedding column/index and regenerate those derived embeddings; until then, the app's 1536-dimensional embedding operations are incompatible with its 32-dimensional column. The configured 0.92 similarity threshold should be recalibrated against labeled ticket pairs before changing it. Embeddings rank similar open tickets from the same customer.

At 10,000 tickets/hour, provider throughput and rate limits, queue depth, and database connections become the first constraints. At one million/day, scale worker replicas and connection pooling, partition or archive old tickets and history, batch queue publishing, and enforce provider concurrency and cost budgets.

## Accuracy and retry policy

The classifier uses the JavaScript SDK’s numeric `ApiError.status` for HTTP errors. HTTP 408, 429, 500, 502, 503, and 504 retain the initial triage retry budget. HTTP 402 indicates a payment problem, 401 and 403 indicate authorization or configuration problems, and 400, 404, and 422 indicate a rejected request. A 429 can represent a rate or quota limit. The SDK does not expose structured quota details or response headers on `ApiError`, so the worker keeps its bounded policy for all 429 responses. [Google Gemini troubleshooting](https://aistudio.google.com/docs/troubleshooting) · [JavaScript SDK ApiError](https://googleapis.github.io/js-genai/release_docs/classes/errors.ApiError.html)

A recognized transport failure, such as `ECONNRESET`, `ETIMEDOUT`, or a documented Gemini SDK timeout or connection error, receives the same bounded three delayed retries as retryable HTTP errors after the SDK's immediate attempts finish. While a connection retry is scheduled, the ticket remains `manual_review` with reason **Gemini connection retry scheduled** and `canRetryClassification: false`. The worker changes it to `processing` under a row lock when the delayed delivery arrives. After the retry budget is exhausted, the reason becomes **Gemini connection failed** and support can retry it manually. Invalid model output, low confidence, TLS/configuration errors, explicit user aborts, and unclassified failures do not receive automatic connection retries. The support endpoint makes one authenticated HTTPS generation request with a five-second deadline and a fixed prompt containing no ticket data. [JavaScript SDK v3.6.1 error wrappers](https://github.com/googleapis/js-genai/blob/v3.6.1/src/gaos/lib/compat-errors.ts) · [SDK timeout and connection errors](https://github.com/googleapis/js-genai/blob/v3.6.1/src/gaos/models/errors/http-client-errors.ts)

The retry endpoint commits the pending status, agent history, and outbox event together. RabbitMQ availability does not affect that database commit; the relay keeps the event until a confirmed publish succeeds. The worker claims pending tickets under a row lock and increments the database attempt number. Duplicate deliveries see the updated status and are acknowledged without starting another classification. On shutdown, the application stops accepting HTTP requests, stops the outbox relay, cancels the worker consumer, waits for active work, then closes RabbitMQ and PostgreSQL. Stale processing is recovered on the worker’s existing scan.

Apply the migration and deploy all updated workers before the API version that exposes support retries. For the retry integration suite, use dedicated PostgreSQL and RabbitMQ instances. Prepare the database with pgvector and the repository migrations, and set the application environment for those instances with `MODEL_PROVIDER=gemini` and a dummy `GEMINI_API_KEY`. The suite simulates Gemini at the SDK’s fetch boundary and deletes the processing queue in the dedicated broker.

```sh
node --require ts-node/register --test src/modules/tickets/__tests__/classificationRetry.integration.test.ts
```

Candidate and judge prompts use explicit priority rules and require an English one-sentence summary even for tickets written in another language. Results below 0.85 confidence need manual review and are not cached. Confidence remains internal.

Exact-text cache hits remain automatic. Embedding-based reuse checks same-customer tickets above a 0.92 cosine similarity starting threshold, aligned with duplicate detection. This is an operating starting point, not a calibrated accuracy guarantee: evaluate it on human-labeled ticket pairs and adjust based on classification errors and reuse coverage. The model verifies the prior category and priority in one call and generates a fresh summary; failed verification falls back to full triage. Similarity alone never copies a prior summary.

To evaluate, collect a representative JSON array of human-labeled tickets with `id`, `expectedCategory`, `expectedPriority`, `predictedCategory`, `predictedPriority`, `triageStatus`, `source`, and `englishSummaryValid`. Include all priority levels, languages, ambiguous tickets, injection attempts, and near duplicates. Run `npx ts-node src/rabbitmq/evaluation.ts path/to/labeled-results.json`. Review urgent misses and semantic reuse errors when adjusting the similarity threshold. These metrics use human labels; the model judge is not ground truth.
