import { describe, expect, it } from 'vite-plus/test';
import { createLocalListCommand, formatTargetListing } from '../../../src/cli/commands/local-list.js';
import type { TargetEntry, TargetListing } from '../../../src/local/target-lister.js';

function entry(displayPath: string | undefined, qualifiedId: string): TargetEntry {
  const [stackName, logicalId] = qualifiedId.split(':') as [string, string];
  const e: TargetEntry = { logicalId, stackName, qualifiedId };
  if (displayPath) e.displayPath = displayPath;
  return e;
}

const empty: TargetListing = {
  lambdas: [],
  apis: [],
  ecsServices: [],
  ecsTaskDefinitions: [],
  loadBalancers: [],
};

describe('formatTargetListing', () => {
  it('reports a clear message when nothing is runnable', () => {
    expect(formatTargetListing(empty, 'cdkl')).toMatch(/No runnable targets/);
  });

  it('groups each category under a header naming the command that runs it', () => {
    const listing: TargetListing = {
      lambdas: [entry('App/Handler', 'App:Handler')],
      apis: [entry('App/HttpApi', 'App:HttpApi')],
      ecsServices: [entry('App/OrdersService/Service', 'App:OrdersService')],
      ecsTaskDefinitions: [entry('App/TaskDef', 'App:TaskDef')],
      loadBalancers: [entry('App/WebLB', 'App:WebLB')],
    };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('Lambda Functions  ->  cdkl invoke <target>');
    expect(out).toContain('APIs  ->  cdkl start-api [target...]');
    expect(out).toContain('ECS Services  ->  cdkl start-service <target...>');
    expect(out).toContain('ECS Task Definitions  ->  cdkl run-task <target>');
    expect(out).toContain('Application Load Balancers  ->  cdkl start-alb <target...>');
  });

  it('appends the API surface kind to each API line', () => {
    const listing: TargetListing = {
      ...empty,
      apis: [
        {
          logicalId: 'HttpApi',
          stackName: 'App',
          qualifiedId: 'App:HttpApi',
          displayPath: 'App/HttpApi',
          kind: 'HTTP API v2',
        },
        {
          logicalId: 'UrlFn',
          stackName: 'App',
          qualifiedId: 'App:UrlFn',
          displayPath: 'App/UrlFn',
          kind: 'Function URL',
        },
      ],
    };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('  App/HttpApi  (HTTP API v2)');
    expect(out).toContain('  App/UrlFn  (Function URL)');
  });

  it('lists one target per line by display path, without the logical ID by default', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry('App/Handler', 'App:Handler')] };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('  App/Handler');
    // The stack-qualified logical ID is NOT shown unless --long is set.
    expect(out).not.toContain('App:Handler');
  });

  it('prints the logical ID on an indented line beneath the path with { long: true }', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry('App/Handler', 'App:Handler')] };
    const out = formatTargetListing(listing, 'cdkl', { long: true });
    expect(out).toContain('  App/Handler');
    expect(out).toContain('      App:Handler');
  });

  it('separates each group with a blank line and leads with one', () => {
    const listing: TargetListing = {
      ...empty,
      lambdas: [entry('App/Handler', 'App:Handler')],
      ecsServices: [entry('App/Svc', 'App:Svc')],
    };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out.startsWith('\n')).toBe(true);
    expect(out).toContain('\n\nECS Services  ->  ');
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

  it('falls back to the qualified ID as the primary line when a target has no display path', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry(undefined, 'App:Raw')] };
    const out = formatTargetListing(listing, 'cdkl');
    expect(out).toContain('  App:Raw');
  });

  it('does not duplicate the qualified ID for a no-display-path target under --long', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry(undefined, 'App:Raw')] };
    const out = formatTargetListing(listing, 'cdkl', { long: true });
    // Only the primary line — no indented repeat of the same ID.
    expect(out.match(/App:Raw/g)?.length).toBe(1);
  });

  it('renders host branding in the command labels', () => {
    const listing: TargetListing = { ...empty, lambdas: [entry('App/Handler', 'App:Handler')] };
    const out = formatTargetListing(listing, 'cdkd local');
    expect(out).toContain('Lambda Functions  ->  cdkd local invoke <target>');
  });
});

describe('createLocalListCommand', () => {
  it('registers the command as `list` with an `ls` alias', () => {
    const cmd = createLocalListCommand();
    expect(cmd.name()).toBe('list');
    expect(cmd.aliases()).toContain('ls');
  });

  it('accepts the deprecated --region flag for parity with sibling commands', () => {
    const cmd = createLocalListCommand();
    expect(cmd.options.some((o) => o.long === '--region')).toBe(true);
  });

  it('registers the -l/--long flag', () => {
    const cmd = createLocalListCommand();
    expect(cmd.options.some((o) => o.short === '-l' && o.long === '--long')).toBe(true);
  });
});
