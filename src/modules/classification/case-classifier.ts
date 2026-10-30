
import type { ClassificationInput } from './classification.schema.js';

/**
 * Provider-independent boundary for proposing a case classification.
 *
 * The returned value is untrusted until validated by the
 * classification policy. This allows adapters to handle raw
 * model responses without weakening domain validation.
 */
export interface CaseClassifier {
  classify(input: ClassificationInput): Promise<unknown>;
}
