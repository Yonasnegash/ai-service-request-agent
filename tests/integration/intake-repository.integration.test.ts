
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { normalizedEmailSchema } from '../../src/modules/intake/normalized-email.schema.js';
import { PostgresIntakeRepository } from '../../src/modules/intake/intake.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

const pool = new Pool({ connectionString: databaseUrl });
const repository = new PostgresIntakeRepository(pool);

const runtimeDatabaseUrl = process.env.TEST_RUNTIME_DATABASE_URL;

if (!runtimeDatabaseUrl) {
  throw new Error(
    'TEST_RUNTIME_DATABASE_URL must be set for runtime-role integration tests',
  );
}

const runtimePool = new Pool({
  connectionString: runtimeDatabaseUrl,
  options: '-c role=service_request_runtime',
});

const runtimeRepository = new PostgresIntakeRepository(runtimePool);

const rollbackTriggerName = 'test_reject_intake_job';
const rollbackFunctionName = 'test_reject_intake_job_fn';

function makeEmail(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID();

  return normalizedEmailSchema.parse({
    source: 'email',
    provider: 'integration-test-provider',
    mailboxId: 'integration-test-mailbox',
    providerMessageId: `message-${suffix}`,
    threadId: `thread-${suffix}`,
    sender: {
      email: `sender-${suffix}@example.com`,
    },
    subject: 'Integration test request',
    bodyText: 'Please help with my service request.',
    receivedAt: new Date().toISOString(),
    attachmentMetadata: [],
    ...overrides,
  });
}

function makeContext(
  overrides: { provider?: string; mailboxId?: string } = {},
) {
  return {
    provider: overrides.provider ?? 'integration-test-provider',
    mailboxId: overrides.mailboxId ?? 'integration-test-mailbox',
  };
}

describe('PostgresIntakeRepository', () => {
  beforeAll(async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.${rollbackFunctionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM public.cases
          WHERE id = NEW.case_id
            AND sender_email LIKE 'rollback-test-%@example.com'
        ) THEN
          RAISE EXCEPTION 'Forced job insertion failure for integration test';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await pool.query(`
      CREATE TRIGGER ${rollbackTriggerName}
      BEFORE INSERT ON public.processing_jobs
      FOR EACH ROW
      EXECUTE FUNCTION public.${rollbackFunctionName}();
    `);
  });

  afterAll(async () => {
    try {
      await pool.query(`
        DROP TRIGGER IF EXISTS ${rollbackTriggerName}
        ON public.processing_jobs;
      `);

      await pool.query(`
        DROP FUNCTION IF EXISTS public.${rollbackFunctionName}();
      `);
    } finally {
      await Promise.all([
        pool.end(),
        runtimePool.end(),
      ])
    }
  });

  it('creates a case and its pending classification job atomically', async () => {
    const email = makeEmail();
    const result = await repository.createCase({
      email,
      context: makeContext(),
    });

    expect(result.outcome).toBe('created');

    const caseId = result.caseId;

    const caseResult = await pool.query(
      `
        SELECT id, status, source_type, source_provider,
               mailbox_id, provider_message_id
        FROM public.cases
        WHERE id = $1
      `,
      [caseId],
    );

    expect(caseResult.rows).toHaveLength(1);
    expect(caseResult.rows[0]).toMatchObject({
      id: caseId,
      source_type: 'email',
      source_provider: email.provider,
      mailbox_id: email.mailboxId,
      provider_message_id: email.providerMessageId,
    });

    const jobResult = await pool.query(
      `
        SELECT case_id, job_type, status, generation
        FROM public.processing_jobs
        WHERE case_id = $1
      `,
      [caseId],
    );

    expect(jobResult.rows).toHaveLength(1);
    expect(jobResult.rows[0]).toMatchObject({
      case_id: caseId,
      job_type: 'CLASSIFY_CASE',
      status: 'PENDING',
    });

    const auditResult = await pool.query(
      `
        SELECT event_type
        FROM public.case_audit_events
        WHERE case_id = $1
          AND event_type = 'CASE_CREATED'
      `,
      [caseId],
    );

    expect(auditResult.rows).toHaveLength(1);
  });

  it('returns the existing case for a duplicate email', async () => {
    const email = makeEmail();

    const first = await repository.createCase({
      email,
      context: makeContext(),
    });

    const second = await repository.createCase({
      email,
      context: makeContext(),
    });

    expect(first.outcome).toBe('created');
    expect(second).toEqual({
      outcome: 'duplicate',
      caseId: first.caseId,
    });

    const jobs = await pool.query(
      'SELECT id FROM public.processing_jobs WHERE case_id = $1',
      [first.caseId],
    );

    expect(jobs.rows).toHaveLength(1);
  });

  it('handles concurrent deliveries of the same email without creating duplicate cases or jobs', async () => {
    const email = makeEmail();
    const input = {
      email,
      context: makeContext(),
    };

    const results = await Promise.all([
      repository.createCase(input),
      repository.createCase(input),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      'created',
      'duplicate',
    ]);

    expect(new Set(results.map((result) => result.caseId)).size).toBe(1);

    const caseCount = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM public.cases
        WHERE source_provider = $1
          AND mailbox_id = $2
          AND provider_message_id = $3
      `,
      [email.provider, email.mailboxId, email.providerMessageId],
    );

    expect(caseCount.rows[0].count).toBe(1);

    const jobCount = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM public.processing_jobs
        WHERE case_id = $1
      `,
      [results[0].caseId],
    );

    expect(jobCount.rows[0].count).toBe(1);
  });

  it('rejects a mismatch between email identity and trusted context', async () => {
    const email = makeEmail();

    await expect(
      repository.createCase({
        email,
        context: makeContext({ mailboxId: 'different-mailbox' }),
      }),
    ).rejects.toThrow(
      'Trusted intake context does not match email identity',
    );

    const caseResult = await pool.query(
      `
        SELECT id
        FROM public.cases
        WHERE source_provider = $1
          AND mailbox_id = $2
          AND provider_message_id = $3
      `,
      [email.provider, email.mailboxId, email.providerMessageId],
    );

    expect(caseResult.rows).toHaveLength(0);
  });

  it('rolls back the case and audit event if job creation fails', async () => {
    const suffix = randomUUID();

    const email = makeEmail({
      sender: {
        email: `rollback-test-${suffix}@example.com`,
      },
    });

    await expect(
      repository.createCase({
        email,
        context: makeContext(),
      }),
    ).rejects.toThrow(
      'Forced job insertion failure for integration test',
    );

    const caseResult = await pool.query(
      `
        SELECT id
        FROM public.cases
        WHERE source_provider = $1
          AND mailbox_id = $2
          AND provider_message_id = $3
      `,
      [email.provider, email.mailboxId, email.providerMessageId],
    );

    expect(caseResult.rows).toHaveLength(0);

    const auditResult = await pool.query(
      `
        SELECT id
        FROM public.case_audit_events
        WHERE details->>'providerMessageId' = $1
      `,
      [email.providerMessageId],
    );

    expect(auditResult.rows).toHaveLength(0);
  });

  it('creates intake using the restricted runtime role', async () => {
        const email = makeEmail();
        const input = {
            email,
            context: makeContext(),
        };

        const roleResult = await runtimePool.query(
            `SELECT current_user AS role_name,
                    current_database() AS database_name`,
        );

        expect(roleResult.rows[0]).toMatchObject({
            role_name: 'service_request_runtime',
            database_name: 'service_request_agent_test',
        });

        const result = await runtimeRepository.createCase(input);

        expect(result.outcome).toBe('created');

        const duplicate = await runtimeRepository.createCase(input);

        expect(duplicate).toEqual({
            outcome: 'duplicate',
            caseId: result.caseId,
        });

        const caseResult = await pool.query(
            `SELECT id, status, current_processing_generation
            FROM public.cases
            WHERE id = $1`,
            [result.caseId],
        );

        expect(caseResult.rows).toHaveLength(1);
        expect(caseResult.rows[0]).toMatchObject({
            id: result.caseId,
            status: 'RECEIVED',
            current_processing_generation: 1,
        });

        const jobResult = await pool.query(
            `SELECT job_type, status, generation
            FROM public.processing_jobs
            WHERE case_id = $1`,
            [result.caseId],
        );

        expect(jobResult.rows).toHaveLength(1);
        expect(jobResult.rows[0]).toMatchObject({
            job_type: 'CLASSIFY_CASE',
            status: 'PENDING',
            generation: 1,
        });

        const auditResult = await pool.query(
            `SELECT event_type
            FROM public.case_audit_events
            WHERE case_id = $1
            AND event_type = 'CASE_CREATED'`,
            [result.caseId],
        );

        expect(auditResult.rows).toHaveLength(1);
    });
});
