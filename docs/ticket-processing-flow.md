# Ticket processing flow

The Express API accepts the ticket and returns HTTP `202` once submission commits. A separate RabbitMQ worker classifies the ticket and records the outcome in PostgreSQL. The status describes the triage workflow. `manual_review` is also used while a Gemini connection retry waits in RabbitMQ; support can manually retry only after the automatic retry budget is exhausted.

All API responses use the shared `{ data, message, toast, response_type }` envelope. `response_type` is `success` for successful responses and `error` for failures; the HTTP status code remains authoritative. Error responses use an empty array for `data`.

## 1. API submission and queue delivery

```mermaid
flowchart TD
    A["POST /api/tickets"] --> B{"authenticate: valid JWT and existing user?"}
    B -- No --> U["401"]
    B -- Yes --> C{"validate with submitSchema: valid body?"}
    C -- No --> V["400"]
    C -- Yes --> D{"submitTicket: support role or matching account email?"}
    D -- No --> W["400"]
    D -- Yes --> E["Open PostgreSQL transaction<br/>Create pending Ticket and submitted history"]
    E --> F["sendToQueue: publish persistent process_ticket message<br/>Wait for broker confirmation"]
    E -- Write error --> X["errorHandler returns 500"]
    F -- Publish error --> X
    F -- Confirmed --> G{"Database commit succeeds?"}
    G -- No --> X
    G -- Yes --> H["202 success envelope with ticket id and triage_status in data"]
    F -- Broker may deliver before commit --> Q["ticket_processing quorum queue"]
    Q --> I["startQueueWorker: consume with prefetch 1"]
    I --> J{"Message available?"}
    J -- No --> Y["Log consumer cancellation and return"]
    J -- Yes --> K{"JSON.parse succeeds?"}
    K -- No --> R["reject(message, true)<br/>Request delayed redelivery"]
    K -- Yes --> L{"queuePayloadSchema passes and action has a handler?"}
    L -- No --> Z["reject(message, false)"]
    L -- Yes --> M["processTicket(ticketId)"]
    M -- returns false --> ACK["ack(message)"]
    M -- returns true or throws --> R
    R -. "Broker redelivery" .-> I
```

| Component                                                                                                                                                    | Exact behavior                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Application startup and middleware registration](../src/app.ts)                                                                                             | `start` authenticates PostgreSQL and connects to RabbitMQ. In API mode it listens on `PORT`. In worker mode it resolves `CONSUMER_TOPIC` against the configured queue names and calls `startQueueWorker`. Startup failures exit with code 1.                                                                                                                                                                                     |
| [API router](../src/router/index.ts) and [ticket router](../src/modules/tickets/router/index.ts)                                                             | The top-level router mounts tickets at `/api`. The submission route calls `authenticate`, `validate(submitSchema)`, then `submitTicket`.                                                                                                                                                                                                                                                                                         |
| [Shared middleware](../src/middleware/index.ts)                                                                                                              | `requestLog` sets `x-request-id` and logs method, path, client IP, status, and duration. `authenticate` uses the token cookie or authorization header, verifies the JWT, and loads the current user via `User.findByPk`. Missing token, invalid token, or missing account returns `401`. `validate` strips unknown body and path fields. `errorHandler` logs propagated errors and sends `500` when headers are still available. |
| [Ticket validation](../src/modules/tickets/validation-schema/index.ts)                                                                                       | `submitSchema` requires a subject of 1–255 characters, a body of 1–20,000 characters, and a valid `customer_email`.                                                                                                                                                                                                                                                                                                              |
| [Ticket controller](../src/modules/tickets/controller/index.ts)                                                                                              | `submitTicket` compares a customer's submitted email to their account email case-insensitively and saves the account email. Support can supply another email. In both cases `customer_id` is the authenticated user's ID, which also controls the scope of same-customer similarity searches. The ticket starts with `retry_count = 0` and `processing_attempt = 0`.                                                             |
| [RabbitMQ connection](../src/rabbitmq/connection.ts), [publisher](../src/rabbitmq/publisher.ts), and [queue schema](../src/rabbitmq/schemas/queue.schema.ts) | `connectRabbitMq` declares the durable quorum queue `ticket_processing` on a publisher-confirm channel. `sendToQueue` publishes `{ action: 'process_ticket', ticketId }` and waits for confirmation. `queuePayloadSchema` requires the configured action and a positive integer `ticketId` and rejects extra fields.                                                                                                             |
| [Queue worker](../src/rabbitmq/workers/worker.ts)                                                                                                            | `startQueueWorker` dispatches through `queueHandlers`. JSON parse errors and thrown handler errors reach the consumer's catch and are requeued. Parsed messages with an invalid schema or unsupported action are rejected without requeue.                                                                                                                                                                                       |

A RabbitMQ publish confirmation can precede the PostgreSQL commit. If the worker reads the ticket before it is visible, `processTicket` can return `false` and the worker acknowledges that delivery. The submission transaction rolls back when publishing throws. A database commit failure after a confirmed publish can leave a queue message with no corresponding ticket.

## 2. Ticket claim, completion, and recovery

```mermaid
flowchart TD
    A["processTicket: lock ticket row in claim transaction"] --> B{"Ticket exists and status is pending, retry_wait, or marked connection retry?"}
    B -- No --> Z["Return false to worker"]
    B -- Yes --> C["Set processing, increment processing_attempt<br/>Set processing_started_at and write history"]
    C --> D["Commit claim, release row lock, reload ticket"]
    D -- Ticket missing --> Z
    D -- Ticket found --> E["cachedTriage: resolve classification outside claim transaction"]
    E -- Valid result --> F{"Completion row lock: same attempt and still processing?"}
    F -- No --> Z
    F -- Yes --> G["TriageResult.findOrCreate by ticket_id"]
    G --> H{"Confidence at least 0.85?"}
    H -- Yes --> I["Set triaged"]
    H -- "No or missing" --> J["Set manual_review<br/>Reason: Low classification confidence"]
    I --> K["Set completed_at, write history, commit"]
    J --> K
    K --> L["detectDuplicate"]
    L --> Z
    E -- Error --> M["Identify invalid output or call classifyProviderError"]
    F -- Transaction error --> M
    G -- Transaction error --> M
    K -- Transaction error --> M
    M --> N{"Failure row lock: same attempt and still processing?"}
    N -- No --> Z
    N -- Yes --> P{"Connection, transient, or rateLimit and retry_count below 3?"}
    P -- Yes --> Q{"Connection failure?"}
    Q -- Yes --> Q1["Keep manual_review<br/>Set scheduled reason and increment retry_count"]
    Q1 --> R["Commit failure state<br/>Return true to worker"]
    Q -- No --> Q2["Set retry_wait<br/>Increment retry_count and write history"]
    Q2 --> R
    P -- No --> S["Set manual_review<br/>Save reason, write history, commit"]
    S --> Z
```

The [processing handler](../src/rabbitmq/handlers/ticketProcessing.handler.ts) sets `last_retry_at` when it claims a ticket from `retry_wait` or the specifically marked connection-retry state. It uses `includes` for the allowed-status check. The claim, completion, and failure transactions each lock the ticket row and write transition history with the current retry count. Completion and failure also require the row to exist, the stored `processing_attempt` to match the claim, and the status to remain `processing`. A connection retry keeps `manual_review` while delayed, then the worker locks the row and changes it to `processing` before inference. The retry API rejects that scheduled reason, preventing a support-triggered run from racing with the delayed delivery. An exception during claim, reload, or failure handling can propagate to the consumer and trigger a requeue. `completed_at` remains empty while a connection retry is scheduled. Successful classification paths save the result source, model name, and prompt version.

| Transition                     | Gate and history reason                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New → `pending`                | Submission succeeds. History reason is `Ticket submitted`.                                                                                                                                   |
| `pending` → `processing`       | Worker claims the ticket. History reason is `Processing started`.                                                                                                                            |
| `retry_wait` → `processing`    | Worker claims a retry. History reason is `Retry processing started`.                                                                                                                         |
| `manual_review` → `processing` | Worker claims only when the reason is `Gemini connection retry scheduled` and the failure code is `geminiConnection`. History reason is `Retry processing started`.                          |
| `processing` → `triaged`       | Valid result with confidence ≥ 0.85. Reason is `Triage completed`.                                                                                                                           |
| `processing` → `manual_review` | Valid result with confidence below 0.85 or missing. Reason is `Low classification confidence`.                                                                                               |
| `processing` → `retry_wait`    | Retryable HTTP failure while `retry_count < 3`. Reason identifies the provider failure.                                                                                                      |
| `processing` → `manual_review` | Connection failure while `retry_count < 3` stays in manual review with reason `Gemini connection retry scheduled`; the worker requests delayed redelivery and manual retry remains disabled. |
| `processing` → `manual_review` | Non-retryable failure or exhausted retries. A connection failure uses reason `Gemini connection failed`, enabling support retry.                                                             |
| `processing` → `pending`       | Stale recovery finds the ticket still processing and older than 35 minutes. Reason is `Previous processing attempt timed out`.                                                               |

### How retries are decided

- [Gemini request options](../src/rabbitmq/triage.ts) configure a 30-second request timeout and three SDK attempts. The candidate correction loop in section 3 is a separate limit.
- [`classifyProviderError`](../src/utils/retry.ts) treats HTTP `429` as `rateLimit`, HTTP `408`, `500`, `502`, `503`, and `504` as `transient`, and the Gemini SDK's `APIConnectionError`, `APIConnectionTimeoutError`, `RequestTimeoutError`, `ConnectionError`, plus recognized socket codes as `connection`. Native `TimeoutError` values in the cause chain are also retryable; explicit abort errors are not. Connection, transient HTTP, and rate-limit failures receive up to three delayed application retries. HTTP `402` is a payment problem, `401/403` is `configuration`, and `400/404/422` is `invalidRequest`. Other errors are `unclassified`.
- [`connectRabbitMq`](../src/rabbitmq/connection.ts) configures native delayed retry of failed deliveries with a 30-second minimum and 120-second maximum. The [README retry policy](../README.md#accuracy-and-retry-policy) documents the usual 30-, 60-, and 90-second delays for three consecutive application retries. The worker uses `reject(message, true)` to request broker redelivery.

### How an abandoned claim is recovered

```mermaid
flowchart LR
    A["recoverStaleTickets<br/>Run on worker startup and every 10 minutes"] --> B["Find processing rows with processing_started_at<br/>older than 35 minutes"]
    B --> C{"Lock each row and recheck that it is still stale"}
    C -- No --> D["Skip row"]
    C -- Yes --> E["Set pending and record timeout history"]
    E --> F["sendToQueue: republish process_ticket"]
    F -- Confirmed --> G["Commit recovery transaction"]
    F -- Error --> H["Roll back and log scan failure"]
```

[`recoverStaleTickets`](../src/rabbitmq/workers/worker.ts) preserves `retry_count` and `processing_attempt` when returning a ticket to `pending`. The next claim increments `processing_attempt`. The previous delivery's completion or failure update is skipped if the status or attempt has changed.

## 3. How the worker chooses a classification

```mermaid
flowchart TD
    A["cachedTriage: hash exact subject and body with SHA-256<br/>Look up text_hash, model_name, and prompt_version"] --> B{"Matching TriageCache row?"}
    B -- Yes --> C["validateResult and return source cache<br/>Validation error goes to processTicket failure handling"]
    B -- No --> D["findSemanticTriage: embedText and search same-customer triaged tickets"]
    D --> E{"Nearest same-model embedding has finite similarity at least 0.92<br/>and prior result matches model and prompt with confidence at least 0.85?"}
    E -- Yes --> F{"verifySemanticReuse: Gemini accepts proposed labels<br/>and fresh candidate passes validation with confidence at least 0.85?"}
    F -- Yes --> G["validateResult, cache by exact text, return source semanticReuse"]
    E -- No --> H["triageText: select MODEL_PROVIDER"]
    F -- No --> H
    D -- Lookup error --> H
    F -- Verification error --> H
    G -- Validation or cache write error --> H
    H -- fake --> I["validateResult: other, medium, fixed summary, confidence 1"]
    H -- gemini --> J["runGeminiTriage and runVerifiedTriage"]
    I --> K["Cache only when confidence is at least 0.85<br/>Return source model"]
    J -- Accepted --> K
    J -- Error --> L["processTicket failure handling"]
    K -- Cache write error --> L
```

- [`cachedTriage` and `validateResult`](../src/rabbitmq/triage.ts) use a hash of `JSON.stringify([subject, body])`, with a shared cache across customers for the same model and prompt version. `resultSchema` requires a known category and priority and a 1–500 character summary. Confidence is optional and must be between 0 and 1 when present. [The configuration](../src/config/index.ts) appends `-confidence-english-v3` to the configured `PROMPT_VERSION`.
- [`findSemanticTriage`](../src/rabbitmq/handlers/ticketProcessing.handler.ts) excludes the current ticket, filters to the same `customer_id` and `triaged` status, and selects the closest stored embedding for `EMBEDDING_MODEL` by ascending pgvector cosine distance. Similarity is `1 - cosineDistance`. It checks the nearest ticket's result only.
- [`embedText`, `formatEmbeddingText`, and `verifySemanticReuse`](../src/rabbitmq/triage.ts) use the subject and body with a sentence similarity task prefix. Embeddings have 1,536 dimensions, from Gemini or a deterministic hash in fake mode. Semantic verification runs in Gemini mode and uses the old category and priority with fresh evidence, summary, and confidence for the new ticket. In fake mode the verifier returns `null`.
- [Ticket enums](../src/modules/tickets/enum/index.ts) define categories `billing`, `technical`, `account`, `feedback`, and `other`, and priorities `low`, `medium`, `high`, and `urgent`. The Gemini prompts define low as minor, medium as routine, high as blocking a core task or materially disrupting service, and urgent as requiring confirmed severe impact such as a security incident or widespread outage.

### Fresh Gemini classification

```mermaid
flowchart TD
    A["runGeminiTriage calls runVerifiedTriage<br/>Up to 3 candidate attempts"] --> B["generateCandidate: call Gemini and parse JSON"]
    B --> C{"validateCandidate: valid shape,<br/>verbatim evidence, and one sentence?"}
    C -- Yes --> D["judgeCandidate: separate call to the same configured model"]
    D --> E{"judgeResultSchema passes and accepted is true?"}
    E -- Yes --> F["validateResult with category, priority, summary, confidence"]
    F -- Valid --> G["Return verified result"]
    B -- Malformed JSON --> H{"Candidate attempts left?"}
    C -- No --> H
    E -- "Invalid response or rejected" --> H
    F -- Invalid --> H
    H -- Yes --> I["Pass correction reason of up to 500 characters"]
    I --> B
    H -- No --> J["Throw Invalid model output"]
    B -- Provider exception --> K["Propagate to processTicket"]
    D -- Provider exception --> K
```

[`validateCandidate` and the judge](../src/rabbitmq/triage.ts) enforce different conditions. Candidate validation requires one to three exact evidence quotes from the subject or body, a summary ending in its only period, question mark, or exclamation point, and required confidence from 0 to 1. The prompts require an English summary and direct both calls to treat ticket text as untrusted data. The separate judge call checks whether the ticket supports the labels, confidence, evidence, and every summary claim. The [Joi schemas](../src/rabbitmq/schemas/triage.schema.ts) define the accepted response fields. Only output validation failures and judge rejection consume the local correction loop. Other exceptions propagate.

## 4. Duplicate linking after completion

```mermaid
flowchart TD
    A["detectDuplicate: called after a valid result commits"] --> B["embedText and TicketEmbedding.findOrCreate by ticket_id"]
    B --> C["Find other same-customer tickets in pending,<br/>processing, retry_wait, or triaged"]
    C --> D{"Closest embedding for EMBEDDING_MODEL exists<br/>with finite cosine similarity at least 0.92?"}
    D -- Yes --> E["Ticket.update sets duplicate_of_ticket_id"]
    D -- No --> F["Return to processTicket"]
    E --> F
    B -- Error --> G["Log error"]
    C -- Error --> G
    D -- Search error --> G
    E -- Error --> G
    G --> F
```

[`detectDuplicate`](../src/rabbitmq/handlers/ticketProcessing.handler.ts) runs for both valid-result statuses, including low-confidence `manual_review`. It writes the duplicate reference after classification and catches its own errors. The worker acknowledges the delivery after this step.

## 5. Reading the outcome

All ticket read routes run `authenticate` before validation.

| Route and controller                                                 | Conditions and response                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tickets/:id` → `getTicket`                                 | `ticketParamsSchema` requires a positive safe integer ID. Validation failure returns `400`. A missing ticket or a different owner's ticket requested by a customer returns `404`. The success envelope's `data` contains `{ id, triage_status }` for customers or `{ ticket, triage_result, canRetryClassification }` for support. The result is `null` when no result row exists.                                                                                                |
| `GET /api/tickets` → `listTickets`                                   | `validateQuery(listTicketsQuerySchema)` checks optional `status`, `category`, and `priority` against the ticket enums. Page defaults to 1 and limit defaults to 20 with a maximum of 100. Invalid or unknown query fields return `400`. Valid requests from a non-support user return `403`. The success envelope's `data` contains `{ data, page, limit, total }`, with tickets ordered newest first. Filtering by category or priority requires a matching `triage_result` row. |
| `POST /api/tickets/:id/retry-classification` → `retryClassification` | Support can retry only tickets in `manual_review` with `geminiConnection` failure code and reason `Gemini connection failed`. A scheduled connection retry has a different reason and is ineligible. The API probes Gemini before the locked state recheck. Success returns `202` with ticket ID and `pending` status in `data`. A missing ticket returns `404`, an ineligible ticket returns `409`, and unavailable Gemini returns `503`.                                        |

See the [ticket router](../src/modules/tickets/router/index.ts), [read schemas](../src/modules/tickets/validation-schema/index.ts), and [controllers](../src/modules/tickets/controller/index.ts).

## PostgreSQL models in the flow

| Model                                                                           | Stored data                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`User`](../src/sequelize/models/users.modal.ts)                                | Account data, including the role and email used by authentication.                                      |
| [`Ticket`](../src/sequelize/models/tickets.modal.ts)                            | Submitted text, owner, status, reason, retry and attempt counters, timestamps, and duplicate reference. |
| [`TicketStatusHistory`](../src/sequelize/models/ticket_status_history.modal.ts) | Previous and new statuses, transition reason, and retry count.                                          |
| [`TriageResult`](../src/sequelize/models/triage_results.modal.ts)               | Per-ticket classification, confidence, source, model name, and prompt version.                          |
| [`TriageCache`](../src/sequelize/models/triage_cache.modal.ts)                  | Validated outcomes keyed by the exact-text hash, model name, and prompt version.                        |
| [`TicketEmbedding`](../src/sequelize/models/ticket_embeddings.modal.ts)         | Stored ticket vector and embedding model for pgvector matching.                                         |
