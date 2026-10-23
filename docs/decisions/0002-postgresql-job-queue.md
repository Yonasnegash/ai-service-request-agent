
# ADR 0002: Use PostgreSQL for Durable Job Processing

- **Status:** Accepted
- **Date:** 2026-10-23
- **Decision owners:** Project maintainer

## Context

The service request agent must process incoming emails asynchronously. Processing may fail because of model-provider timeouts, invalid model output, database errors, or worker interruptions.

The system must preserve pending work, prevent concurrent workers from improperly claiming the same job, support bounded retries, and recover jobs abandoned by crashed workers.

The MVP already uses PostgreSQL for case records, processing attempts, routing policies, and audit events. Introducing a separate message broker would add another infrastructure dependency.

## Decision

Use PostgreSQL as the initial durable job queue.

Store jobs in a dedicated table and manage them through database transactions, row locking, scheduled availability, attempt tracking, and worker leases.

Workers will claim eligible jobs using a concurrency-safe approach, such as `SELECT ... FOR UPDATE SKIP LOCKED`, and commit ownership before calling the AI provider.

The job system will support:

- Durable pending jobs.
- Explicit job states and bounded attempts.
- Scheduled retries with backoff.
- Worker leases and recovery of abandoned jobs.
- Visible handling of exhausted failures.
- Idempotent completion and protection against stale workers.

Job creation must occur in the same transaction as case registration. Decision persistence and job completion must also be coordinated transactionally.

External AI calls must not run inside long-lived database transactions.

## Alternatives Considered

### Dedicated message broker

Use a separate broker such as RabbitMQ or Kafka for background job delivery.

**Reasons not selected for the initial MVP:**

- Adds infrastructure and operational responsibilities.
- Requires additional coordination between message delivery and PostgreSQL state.
- Introduces more complexity before the workload and throughput requirements are known.

A dedicated broker may become appropriate if throughput, independent consumers, event streaming, or operational requirements justify it.

### In-memory queue

Keep jobs in application memory.

**Reasons not selected:**

- Pending jobs can be lost when the process restarts.
- Multiple application instances cannot reliably coordinate through a local in-memory queue.
- Durable retries and recovery become harder to implement correctly.

## Consequences

### Benefits

- Fewer infrastructure dependencies.
- Case creation and job creation can be atomic.
- Job state, retry history, and operational recovery remain visible in the database.
- The implementation is suitable for integration and concurrency testing.

### Trade-offs

- Job polling and locking add database workload.
- Poor claim or recovery logic can cause contention or delayed processing.
- Lease expiry, stale workers, retry exhaustion, and idempotent completion require careful handling.
- The job table may need indexing, cleanup, or partitioning if volume grows substantially.

## Review Conditions

Reconsider this decision if measured job volume, database contention, processing latency, event-streaming needs, or independent-consumer requirements make a dedicated broker more appropriate.

Before production use, validate concurrent job claiming, lease recovery, retry exhaustion, and behavior when a worker fails immediately before or after committing a decision.
