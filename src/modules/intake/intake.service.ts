
import { z } from 'zod';

import {
  classifyIntakeError,
  IntakeError,
} from './intake.errors.js';
import type {
  IntakePersistenceResult,
  IntakeRepository,
  TrustedIntakeContext,
} from './intake.repository.js';
import { normalizedEmailSchema } from './normalized-email.schema.js';

const trustedIntakeContextSchema = z
  .object({
    provider: z.string().refine(
      (value) => value.trim().length > 0,
      'Must not be blank',
    ),
    mailboxId: z.string().refine(
      (value) => value.trim().length > 0,
      'Must not be blank',
    ),
  })
  .strict();

export type IntakeResult = IntakePersistenceResult;

export class IntakeService {
  constructor(private readonly repository: IntakeRepository) {}

  async intakeEmail(
    input: unknown,
    context: unknown,
  ): Promise<IntakeResult> {
    const emailResult = normalizedEmailSchema.safeParse(input);

    if (!emailResult.success) {
      throw new IntakeError('INVALID_INPUT', {
        cause: emailResult.error,
      });
    }

    const contextResult =
      trustedIntakeContextSchema.safeParse(context);

    if (!contextResult.success) {
      throw new IntakeError('INVALID_INPUT', {
        cause: contextResult.error,
      });
    }

    const email = emailResult.data;
    const trustedContext: TrustedIntakeContext =
      contextResult.data;

    if (
      email.provider !== trustedContext.provider ||
      email.mailboxId !== trustedContext.mailboxId
    ) {
      throw new IntakeError('PERMANENT_CONFIGURATION_ERROR');
    }

    try {
      return await this.repository.createCase({
        email,
        context: trustedContext,
      });
    } catch (error) {
      throw classifyIntakeError(error);
    }
  }
}
