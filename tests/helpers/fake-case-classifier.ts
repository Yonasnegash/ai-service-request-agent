
import type { CaseClassifier } from '../../src/modules/classification/case-classifier.js';
import type { ClassificationInput } from '../../src/modules/classification/classification.schema.js';

export class FakeCaseClassifier implements CaseClassifier {
  readonly receivedInputs: ClassificationInput[] = [];

  constructor(private readonly output: unknown) {}

  async classify(input: ClassificationInput): Promise<unknown> {
    this.receivedInputs.push({ ...input });
    return this.output;
  }
}
