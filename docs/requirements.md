
# Requirements — AI Service Request Processing Agent

## 1. Problem Statement

Organizations receive service requests through email. Employees must read each message, understand the customer's issue, categorize it, identify missing information, and forward it to the appropriate team.

Manual processing can be slow and inconsistent, especially when request volumes increase or messages contain multiple issues.

This project explores how an AI-assisted workflow can reduce repetitive triage work while preserving human control over business decisions and customer communication.

## 2. Project Goal

Build a reliable, auditable AI agent that processes incoming service-request emails, summarizes their content, identifies likely categories, detects ambiguity and missing information, and recommends the appropriate team queue.

The application—not the language model—will enforce routing rules, validate outputs, manage retries, and control case status transitions.

## 3. Target Users

- **Service operations employees:** Review incoming cases and handle customer requests.
- **Support team leads:** Monitor routing accuracy, workload, and cases requiring review.
- **Engineering teams:** Operate, evaluate, and improve the processing system.

## 4. Minimum Viable Product (MVP)

The MVP will:

1. Accept normalized email messages through a defined intake interface.
2. Validate incoming messages and prevent duplicate processing.
3. Generate a concise summary of each request.
4. Identify one primary category and any relevant secondary categories.
5. Detect ambiguity and missing information.
6. Apply deterministic rules to select a team queue.
7. Send uncertain or invalid classifications to human review.
8. Persist case status, processing attempts, and audit events.
9. Retry eligible failures within configured limits.
10. Provide automated tests and an evaluation dataset using synthetic examples.

## 5. Categories and Routing

| Category              | Destination       |
| --------------------- | ----------------- |
| `payment_issue`     | Payment support   |
| `account_support`   | Account support   |
| `technical_support` | Technical support |
| `complaint`         | Customer care     |
| `other`             | General triage    |

If a message contains multiple issues, the application will apply a documented category-precedence policy and preserve secondary categories.

Ambiguous requests will be routed to human review rather than automatically assigned based on an uncertain interpretation.

The category precedence and complaint-handling rules must be reviewed before production use.

## 6. Human Oversight and Safety

- Employees remain responsible for resolving and closing cases.
- The agent will not send customer replies autonomously.
- The model cannot select its own authoritative team assignment or override application policies.
- Automatic routing eligibility will be based on validated model outputs and an evaluated decision policy; a model-reported confidence score alone is not sufficient.
- Model outputs must be validated against a strict schema and approved category values.
- Incoming email content is untrusted input and may contain instructions intended to manipulate the model.
- Sensitive actions require application-level authorization, not model judgment.
- Uncertain classifications must be visible and recoverable.

## 7. Out of Scope for the MVP

- Autonomous customer replies.
- Email attachment content extraction.
- Automatic financial transactions or account changes.
- Automatic case resolution or closure.
- Multi-agent orchestration.
- Microservices deployment.
- Production integration with a real customer mailbox.

## 8. Technical Direction

The initial implementation is planned around:

- TypeScript and Node.js.
- Express for the HTTP application.
- PostgreSQL for durable state and audit records.
- Zod for runtime validation.
- Vitest for automated testing.
- Docker Compose for local development.
- GitHub Actions for continuous integration.

The language-model provider will be accessed through a replaceable interface so the application does not depend on a single provider.

Cloud deployment and Azure integration are later milestones, not prerequisites for the MVP.

## 9. Success Criteria

The project will be considered ready for an initial demonstration when:

- Duplicate message delivery does not create duplicate cases or active initial jobs.
- Valid classifications produce the expected routing decisions.
- Ambiguous, unsupported, and invalid model outputs are handled safely.
- Failures can be retried or recovered without silently losing requests.
- Case transitions and processing decisions are auditable.
- Automated tests cover important business rules and failure scenarios.
- Evaluation results report classification quality, routing accuracy, human-review rate, latency, and estimated cost.
- The README explains the architecture, limitations, setup, tests, and evaluation results honestly.

Numeric quality thresholds will be established after creating and evaluating a representative test dataset rather than being invented in advance.

## 10. Open Questions

- What service-level targets should apply to incoming requests?
- What classification quality is required before automatic routing is permitted?
- Which categories require special escalation or complaint-handling procedures?
- What email data-retention and deletion policies should apply?
- Which model provider and deployment environment should be selected after initial evaluation?
