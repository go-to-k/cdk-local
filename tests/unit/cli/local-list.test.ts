import { describe, expect, it } from 'vite-plus/test';
import { createLocalListCommand, formatTargetListing } from '../../../src/cli/commands/local-list.js';
import type { TargetEntry, TargetListing } from '../../../src/local/target-lister.js';

function entry(displayPath: string | undefined, qualifiedId: string): TargetEntry {
  const [stackName, logicalId] = qualifiedId.split(':') as [string, string];
  const e: TargetEntry = { logicalId, stackName, qualifiedId };
  if (displayPath) e.displayPath = displayPath;
  return e;
}

const empty: TargetListing = { lambdas: [], apis: [], ecsServices: [], ecsTaskDefinitions: [] };

describe('formatTargetListing', () => {
  it('reports a clear message when nothing is runnable', () => {
    expect(formatTargetListing(empty, 'cdkl')).toMatch(/No runnable targets/);
  });

  it('groups each category under the command that runs it, with both target forms', () => {
    const listing: TargetListing = {
      lambdas: [entry('App/Handler', 'App:Handler')],
      apis: [entry('App/HttpApi', 'App:HttpApi')],
      ecsServices: [entry('App/OrdersService/Service', 'App:OrdersService')],
      ecsTaskDefinitions: [entry('App/TaskDef', 'App:TaskDef')],
    };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('Lambda Functions  (cdkl invoke <target>)');
    expect(out).toContain('  App/Handler  App:Handler');
    expect(out).toContain('APIs  (cdkl start-api [target])');
    expect(out).toContain('ECS Services  (cdkl start-service <target...>)');
    expect(out).toContain('  App/OrdersService/Service  App:OrdersService');
    expect(out).toContain('ECS Task Definitions  (cdkl run-task <target>)');
  });

  it('omits categories with no targets', () => {
    const listing: TargetListing = {
      ...empty,
      ecsServices: [entry('App/OrdersService', 'App:OrdersService')],
    };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('ECS Services');
    expect(out).not.toContain('Lambda Functions');
    expect(out).not.toContain('APIs');
    expect(out).not.toContain('ECS Task Definitions');
  });

  it('falls back to the qualified ID alone when a target has no display path', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry(undefined, 'App:Raw')] };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('  App:Raw');
  });

  it('aligns the display-path column within a category', () => {
    const listing: TargetListing = {
      ...empty,
      lambdas: [entry('App/Short', 'App:Short'), entry('App/MuchLongerName', 'App:Long')],
    };
    const out = formatTargetListing(listing, 'cdkl');
    // Both qualified IDs start at the same column (padded to the longest path).
    const shortLine = out.split('\n').find((l) => l.includes('App:Short'))!;
    const longLine = out.split('\n').find((l) => l.includes('App:Long'))!;
    expect(shortLine.indexOf('App:Short')).toBe(longLine.indexOf('App:Long'));
  });

  it('renders host branding in the command labels', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry('App/Handler', 'App:Handler')] };
    const out = formatTargetListing(listing, 'cdkd local');
    expect(out).toContain('Lambda Functions  (cdkd local invoke <target>)');
  });
});

describe('createLocalListCommand', () => {
  it('registers the command as `list` with an `ls` alias', () => {
    const cmd = createLocalListCommand();
    expect(cmd.name()).toBe('list');
    expect(cmd.aliases()).toContain('ls');
  });
});
