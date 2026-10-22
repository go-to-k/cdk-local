import { describe, expect, it } from 'vite-plus/test';
import {
  makePinClassifier,
  makeTaskPinClassifier,
} from '../../../src/cli/commands/local-studio.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// go-to-k/cdk-local#761 (S3): the id studio names in a classify warning renders
// bare when plain and as ONE JSON string literal when it could forge a boundary.
// Expected strings are hand-written, never computed through the display helper.

const stacks = [
  {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    template: { Resources: {} },
    dependencyNames: [],
  } as unknown as StackInfo,
];

function capture(): { warns: string[]; logger: never } {
  const warns: string[] = [];
  const logger = {
    warn: (m: string) => warns.push(m),
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as never;
  return { warns, logger };
}

describe('studio pin classifier warns render the target id (#761)', () => {
  it('service: plain id bare', () => {
    const { warns, logger } = capture();
    expect(makePinClassifier({ stacks, contextByStack: new Map(), logger })('S:Svc')).toBe(false);
    expect(warns[0]).toMatch(
      /^studio: could not classify image-pin status for ECS service S:Svc; leaving it unmarked /
    );
  });

  it('service: forging id as a JSON literal', () => {
    const { warns, logger } = capture();
    makePinClassifier({ stacks, contextByStack: new Map(), logger })("S:a' b\u001b[2Kx");
    expect(warns[0]).toMatch(
      /^studio: could not classify image-pin status for ECS service "S:a' b {1}\[2Kx"; leaving it unmarked /
    );
  });

  it('task definition: plain and forging', () => {
    const plain = capture();
    makeTaskPinClassifier({ stacks, contextByStack: new Map(), logger: plain.logger })('S:Task');
    expect(plain.warns[0]).toMatch(
      /^studio: could not classify image-pin status for ECS task definition S:Task; leaving it unmarked /
    );
    const forged = capture();
    makeTaskPinClassifier({ stacks, contextByStack: new Map(), logger: forged.logger })("S:T' x");
    expect(forged.warns[0]).toMatch(
      /^studio: could not classify image-pin status for ECS task definition "S:T' x"; leaving it unmarked /
    );
  });
});
