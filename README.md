
# AI Service Request Processing Agent

An AI-assisted service request processing system that classifies incoming email requests, applies deterministic routing policies, and supports auditable, recoverable human-in-the-loop workflows.

## Project Status

**Phase:** Requirements and architecture design.

The application is not implemented yet. Features described in the requirements are planned until they have been built and tested.

## Goals

- Reduce repetitive email triage work.
- Apply consistent, testable routing policies.
- Escalate ambiguous cases to human review.
- Maintain durable processing records and audit history.
- Evaluate model quality, reliability, latency, and cost.

## Scope

The initial version focuses on email intake, classification, deterministic routing, failure recovery, and human oversight.

It will not send customer replies autonomously or perform sensitive business actions.

## Documentation

- [Requirements](docs/requirements.md)

## Technology Direction

TypeScript, Node.js, Express, PostgreSQL, Zod, Vitest, Docker Compose, and GitHub Actions.

These technologies are planned and will be introduced incrementally.
