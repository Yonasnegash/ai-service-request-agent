
import type { Pool, PoolClient } from 'pg';

import type { NormalizedEmail } from './normalized-email.schema.js';
import { IntakeRepositoryInvariantError } from './intake.errors.js';

export interface TrustedIntakeContext {
  provider: string;
  mailboxId: string;
}

export interface CreateCaseInput {
  email: NormalizedEmail;
  context: TrustedIntakeContext;
}

export type IntakePersistenceResult =
  | {
      outcome: 'created';
      caseId: string;
    }
  | {
      outcome: 'duplicate';
      caseId: string;
    };

export interface IntakeRepository {
  createCase(input: CreateCaseInput): Promise<IntakePersistenceResult>;
}

interface CaseIdRow {
  id: string;
}

interface CaseGenerationRow {
  id: string;
  current_processing_generation: number;
}

export class PostgresIntakeRepository implements IntakeRepository {
  constructor(private readonly pool: Pool) {}

  async createCase(
    input: CreateCaseInput,
  ): Promise<IntakePersistenceResult> {
    const { email, context } = input;

    if (
      email.provider !== context.provider ||
      email.mailboxId !== context.mailboxId
    ) {
      throw new IntakeRepositoryInvariantError();
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const insertedCase = await client.query<CaseIdRow>(
        `
          INSERT INTO public.cases (
            source_type,
            source_provider,
            mailbox_id,
            provider_message_id,
            thread_id,
            sender_email,
            subject,
            body_text,
            received_at,
            attachment_metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT (
            source_provider,
            mailbox_id,
            provider_message_id
          ) DO NOTHING
          RETURNING id
        `,
        [
          email.source,
          email.provider,
          email.mailboxId,
          email.providerMessageId,
          email.threadId ?? null,
          email.sender.email,
          email.subject,
          email.bodyText,
          email.receivedAt,
          JSON.stringify(email.attachmentMetadata),
        ],
      );

      const createdCase = insertedCase.rows[0];

      if (createdCase === undefined) {
        const existingCase = await client.query<CaseIdRow>(
          `
            SELECT id
            FROM public.cases
            WHERE source_provider = $1
              AND mailbox_id = $2
              AND provider_message_id = $3
          `,
          [email.provider, email.mailboxId, email.providerMessageId],
        );

        const duplicateCase = existingCase.rows[0];

        if (duplicateCase === undefined) {
          throw new Error(
            'Duplicate case identity conflicted, but the existing case was not found',
          );
        }

        await client.query('COMMIT');

        return {
          outcome: 'duplicate',
          caseId: duplicateCase.id,
        };
      }

      const caseGeneration = await client.query<CaseGenerationRow>(
        `
          SELECT id, current_processing_generation
          FROM public.cases
          WHERE id = $1
        `,
        [createdCase.id],
      );

      const persistedCase = caseGeneration.rows[0];

      if (persistedCase === undefined) {
        throw new Error('Inserted case could not be read back');
      }

      await client.query(
        `
          INSERT INTO public.processing_jobs (
            case_id,
            job_type,
            status,
            generation
          )
          VALUES ($1, 'CLASSIFY_CASE', 'PENDING', $2)
        `,
        [persistedCase.id, persistedCase.current_processing_generation],
      );

      await client.query('COMMIT');

      return {
        outcome: 'created',
        caseId: persistedCase.id,
      };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error; the connection is released in finally.
    }
  }
}
