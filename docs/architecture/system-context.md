
# System Context

## 1. Purpose

The AI Service Request Processing Agent automates the initial processing of incoming service request emails. It helps reduce manual classification and routing work while keeping business decisions controlled, traceable, and recoverable.

The system uses AI to summarize requests, identify category candidates, and extract relevant fields. Application code validates the AI output and applies deterministic business rules to determine routing and whether human review is required.

## 2. Problem Statement

In the current workflow, employees read incoming service requests, classify them, search records and policies, check completeness, route requests, and follow up.

This manual process provides human judgment but requires employees to perform repetitive initial processing.

The proposed system automates the initial classification and routing workflow without removing employee responsibility for customer communication, investigation, resolution, or case closure.

## 3. Actors and External Systems

### Human actors

- **Service employee:** Reviews assigned requests, investigates issues, communicates with customers, and updates case status.
- **Review employee:** Handles ambiguous, incomplete, invalid, or otherwise escalated requests.
- **System operator:** Monitors processing failures and operational health and supports recovery when automated processing cannot continue.

These are proposed logical roles. Actual organizational roles and permissions will be confirmed when access control is designed.

### External systems

- **Email provider:** Supplies incoming service request messages through an integration adapter. The specific provider and integration mechanism have not yet been selected.
- **AI model provider:** Classifies request content and extracts relevant fields through a replaceable classifier interface.
- **PostgreSQL database:** Stores cases, processing jobs, processing attempts, routing policies, and audit events.

## 4. System Responsibilities

The system is responsible for:

1. Receiving and validating normalized email input.
2. Registering each unique provider message idempotently and assigning a case ID.
3. Creating durable processing jobs.
4. Using AI to summarize requests, propose categories, and extract relevant fields.
5. Validating AI output against a strict schema and approved business rules.
6. Applying deterministic category precedence and team-routing rules.
7. Flagging incomplete, ambiguous, or invalid requests for appropriate human handling.
8. Managing processing attempts, bounded retries, and recovery of abandoned jobs.
9. Recording case changes, processing outcomes, errors, and audit events.
10. Exposing basic operational metrics for monitoring and evaluation.

## 5. System Boundaries

### Included in the MVP

- Email-based intake.
- Request classification and field extraction.
- Schema and business-rule validation.
- Deterministic routing to a team queue.
- Human review for exceptions.
- Duplicate-delivery protection.
- Durable background processing and recovery.
- Case lifecycle management and audit history.
- Basic testing, evaluation, and operational metrics.

### Excluded from the MVP

- Automated customer replies.
- Automated case investigation or resolution.
- Automated policy retrieval or knowledge-base integration.
- Email attachment content processing.
- Autonomous approval of sensitive actions.
- Employee-specific assignment by the AI model.
- Production Azure deployment before the core workflow is validated.

## 6. Key Business Rules

- The model proposes classifications; the application determines the authoritative routing outcome.
- The application accepts only validated, allowlisted category values.
- Multiple categories are resolved using documented primary-category precedence; secondary categories are preserved.
- Unknown categories are routed to general triage.
- Ambiguous classifications require human review.
- Missing information is recorded separately from review status.
- A model-reported confidence score alone is not sufficient to authorize automatic routing.
- Duplicate deliveries of the same provider message must not create multiple cases or initial processing jobs.
- Email content is untrusted input and must not override system instructions or application policy.
- Customer communication, investigation, resolution, and closure remain under employee control.
- Processing failures must be visible and recoverable.

## 7. Architectural Approach

The initial implementation will use a modular monolith built with TypeScript and Node.js.

Express will provide the API boundary, PostgreSQL will provide durable storage and job coordination, and the AI integration will be isolated behind a classifier interface.

The architecture will prioritize clear module boundaries, transactional consistency, deterministic business rules, testability, and operational recovery. Microservices and additional infrastructure will be considered only if demonstrated requirements justify them.

## 8. Future Extensions

Potential future extensions include:

- Policy retrieval and knowledge-base integration.
- Email attachment processing.
- Additional email providers.
- A human review interface.
- More advanced evaluation and monitoring.
- Azure deployment and production integrations.

These extensions are not part of the initial MVP.

## 9. Open Questions

The following decisions remain to be confirmed as the project develops:

- Which email provider and intake mechanism will be used?
- Which AI model provider will be used for the first implementation?
- Which categories and sensitive-request rules require business-owner approval?
- What evaluation results are required before enabling automatic routing?
- What retention and deletion policies should apply to email content and audit records?
- Which authentication and authorization mechanisms will protect employee operations?
