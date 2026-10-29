
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IntakeError,
  IntakeRepositoryInvariantError,
} from '../../src/modules/intake/intake.errors.js';
import { IntakeService } from '../../src/modules/intake/intake.service.js';
import type { IntakeRepository } from '../../src/modules/intake/intake.repository.js';

const validEmail = {
  source: 'email',
  provider: 'example-mail',
  mailboxId: 'support-inbox',
  providerMessageId: 'message-123',
  sender: {
    email: 'customer@example.com',
  },
  subject: 'Payment issue',
  bodyText: 'My payment did not go through.',
  receivedAt: '2026-10-29T08:00:00Z',
  attachmentMetadata: [],
};

const validContext = {
  provider: 'example-mail',
  mailboxId: 'support-inbox',
};

describe('IntakeService', () => {
  const createCase = vi.fn<IntakeRepository['createCase']>();

  const repository: IntakeRepository = {
    createCase,
  };

  const service = new IntakeService(repository);

  beforeEach(() => {
    createCase.mockReset();
  });

  it('returns the result when a case is created', async () => {
    createCase.mockResolvedValue({
      outcome: 'created',
      caseId: 'case-123',
    });

    await expect(
      service.intakeEmail(validEmail, validContext),
    ).resolves.toEqual({
      outcome: 'created',
      caseId: 'case-123',
    });

    expect(createCase).toHaveBeenCalledOnce();
  });

  it('returns the existing case when intake is a duplicate', async () => {
    createCase.mockResolvedValue({
      outcome: 'duplicate',
      caseId: 'case-existing',
    });

    await expect(
      service.intakeEmail(validEmail, validContext),
    ).resolves.toEqual({
      outcome: 'duplicate',
      caseId: 'case-existing',
    });
  });

  it('rejects an invalid email without calling the repository', async () => {
    await expect(
      service.intakeEmail({ ...validEmail, sender: {} }, validContext),
    ).rejects.toMatchObject({
      name: 'IntakeError',
      code: 'INVALID_INPUT',
    });

    expect(createCase).not.toHaveBeenCalled();
  });

  it('rejects malformed trusted context as invalid input', async () => {
    await expect(
      service.intakeEmail(validEmail, {
        provider: 'example-mail',
      }),
    ).rejects.toMatchObject({
      name: 'IntakeError',
      code: 'INVALID_INPUT',
    });

    expect(createCase).not.toHaveBeenCalled();
  });

  it('rejects a provider or mailbox mismatch before persistence', async () => {
    await expect(
      service.intakeEmail(validEmail, {
        ...validContext,
        mailboxId: 'different-inbox',
      }),
    ).rejects.toMatchObject({
      name: 'IntakeError',
      code: 'PERMANENT_CONFIGURATION_ERROR',
    });

    expect(createCase).not.toHaveBeenCalled();
  });

  it('classifies recognized connection failures as transient', async () => {
    const databaseError = Object.assign(
      new Error('Internal database connection details'),
      { code: '08006' },
    );

    createCase.mockRejectedValue(databaseError);

    const error = await service
      .intakeEmail(validEmail, validContext)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntakeError);
    expect(error).toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_ERROR',
      message: 'Intake persistence is temporarily unavailable',
      cause: databaseError,
    });

    expect((error as Error).message).not.toContain(
      'Internal database connection details',
    );
  });

  it('classifies unexpected database errors without exposing details', async () => {
    const databaseError = Object.assign(
      new Error('Internal SQL details'),
      { code: '42P01' },
    );

    createCase.mockRejectedValue(databaseError);

    await expect(
      service.intakeEmail(validEmail, validContext),
    ).rejects.toMatchObject({
      code: 'UNEXPECTED_INTERNAL_ERROR',
      message:
        'An unexpected error occurred while processing intake',
      cause: databaseError,
    });
  });

  it('translates the typed repository invariant error into a configuration error', async () => {
    const repositoryError = new IntakeRepositoryInvariantError();
    createCase.mockRejectedValue(repositoryError);

    await expect(
        service.intakeEmail(validEmail, validContext),
    ).rejects.toMatchObject({
        name: 'IntakeError',
        code: 'PERMANENT_CONFIGURATION_ERROR',
        cause: repositoryError,
    });
   });

  it('does not retry transient errors automatically', async () => {
    createCase.mockRejectedValue(
      Object.assign(new Error('Connection lost'), {
        code: '08006',
      }),
    );

    await expect(
      service.intakeEmail(validEmail, validContext),
    ).rejects.toMatchObject({
      code: 'TRANSIENT_INFRASTRUCTURE_ERROR',
    });

    expect(createCase).toHaveBeenCalledOnce();
  });

  it.each([
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EAI_AGAIN',
    ])('classifies %s as a transient network failure', async (code) => {
        const networkError = Object.assign(
            new Error('Internal network details'),
            { code },
        );

        createCase.mockRejectedValue(networkError);

        await expect(
            service.intakeEmail(validEmail, validContext),
        ).rejects.toMatchObject({
            code: 'TRANSIENT_INFRASTRUCTURE_ERROR',
            cause: networkError,
        });

        expect(createCase).toHaveBeenCalledOnce();
    });

    it('classifies an unknown error as unexpected', async () => {
        const unexpectedError = new Error('Internal implementation details');
        createCase.mockRejectedValue(unexpectedError);

        await expect(
            service.intakeEmail(validEmail, validContext),
        ).rejects.toMatchObject({
            code: 'UNEXPECTED_INTERNAL_ERROR',
            message: 'An unexpected error occurred while processing intake',
            cause: unexpectedError,
        });
    });
});
