
# ADR 0001: Use a Modular Monolith

- **Status:** Accepted
- **Date:** 2026-10-23
- **Decision owners:** Project maintainer

## Context

The AI Service Request Processing Agent needs to receive service emails, register cases, classify requests using an AI model, apply deterministic routing rules, manage asynchronous processing, and maintain an auditable case history.

I’m building this as a public portfolio project, leveraging my TypeScript and Node.js backend experience. The first milestone is a testable MVP rather than a distributed production platform.

The system requires clear separation between AI integration, business rules, persistence, processing, and case lifecycle management. It also needs reliable database transactions, safe job processing, and the ability to test individual components.

## Decision

Build the initial system as a modular monolith using TypeScript and Node.js, with Express as the API framework and PostgreSQL as the primary persistence and job-coordination mechanism.

Organize the codebase into modules for intake, cases, classification, routing, processing, and audit, with shared infrastructure for database access, email integration, AI-provider integration, and observability.

Keep business rules independent of provider-specific integrations. Define interfaces around external dependencies so implementations can be replaced without rewriting the core workflow.

## Alternatives Considered

### Microservices

Separate intake, classification, routing, and case management into independently deployed services.

**Reasons not selected:**

- Adds deployment, networking, and operational complexity before the MVP requires independent scaling.
- Makes transactions across case creation, job creation, and audit recording more difficult.
- Increases the amount of infrastructure needed to develop and demonstrate the project.

Microservices may be reconsidered if independently scaling or deploying particular components becomes a demonstrated requirement.

### Single, tightly coupled application

Implement all functionality without explicit module boundaries.

**Reasons not selected:**

- Makes business rules harder to test independently.
- Encourages provider-specific integration code to spread through the application.
- Makes future changes to classification, routing, and processing more difficult to isolate.

## Consequences

### Benefits

- One application is easier to develop, test, run, and deploy.
- Module boundaries support maintainability and focused testing.
- Database transactions can coordinate related changes within one PostgreSQL database.
- External AI and email integrations can be replaced behind interfaces.
- The project can demonstrate production-minded engineering without unnecessary infrastructure.

### Trade-offs

- Modules share one deployment and runtime lifecycle.
- Module boundaries must be maintained through code organization and review.
- A single deployment may eventually limit independent scaling or fault isolation.
- PostgreSQL-backed job coordination requires careful implementation of concurrent claims, leases, retries, and recovery.

## Review Conditions

Reconsider this decision if the system demonstrates a need for independent component deployment, significantly different scaling requirements, or fault isolation that cannot reasonably be achieved within the modular monolith.
