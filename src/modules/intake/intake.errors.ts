
export type IntakeErrorCode =
  | 'INVALID_INPUT'
  | 'PERMANENT_CONFIGURATION_ERROR'
  | 'TRANSIENT_INFRASTRUCTURE_ERROR'
  | 'UNEXPECTED_INTERNAL_ERROR';

const publicMessages: Record<IntakeErrorCode, string> = {
  INVALID_INPUT: 'The intake request is invalid',
  PERMANENT_CONFIGURATION_ERROR:
    'The intake integration configuration is invalid',
  TRANSIENT_INFRASTRUCTURE_ERROR:
    'Intake persistence is temporarily unavailable',
  UNEXPECTED_INTERNAL_ERROR:
    'An unexpected error occurred while processing intake',
};

export class IntakeError extends Error {
  constructor(
    public readonly code: IntakeErrorCode,
    options?: ErrorOptions,
  ) {
    super(publicMessages[code], options);
    this.name = 'IntakeError';
  }
}

export class IntakeRepositoryInvariantError extends Error {
  constructor() {
    super('Trusted intake context does not match email identity');
    this.name = 'IntakeRepositoryInvariantError';
  }
}

const transientPostgresCodes = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const transientNetworkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
]);

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string'
  ) {
    return undefined;
  }

  return error.code;
}

export function classifyIntakeError(error: unknown): IntakeError {
  if (error instanceof IntakeError) {
    return error;
  }

  if (error instanceof IntakeRepositoryInvariantError) {
    return new IntakeError('PERMANENT_CONFIGURATION_ERROR', {
      cause: error,
    });
  }

  const errorCode = getErrorCode(error);

  if (
    errorCode?.startsWith('08') ||
    (errorCode !== undefined &&
      (transientPostgresCodes.has(errorCode) ||
        transientNetworkCodes.has(errorCode)))
  ) {
    return new IntakeError('TRANSIENT_INFRASTRUCTURE_ERROR', {
      cause: error,
    });
  }

  return new IntakeError('UNEXPECTED_INTERNAL_ERROR', {
    cause: error,
  });
}
