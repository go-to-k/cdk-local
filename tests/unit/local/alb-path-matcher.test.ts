import { describe, it, expect } from 'vite-plus/test';
import {
  albCidrMatches,
  albHostPatternMatches,
  albPathPatternMatches,
  httpHeaderConditionMatches,
  matchAlbPathRule,
  queryStringConditionMatches,
  type AlbPathRule,
} from '../../../src/local/alb-path-matcher.js';

describe('albPathPatternMatches', () => {
  it('matches an exact literal path', () => {
    expect(albPathPatternMatches('/health', '/health')).toBe(true);
    expect(albPathPatternMatches('/health', '/healthz')).toBe(false);
    expect(albPathPatternMatches('/health', '/health/')).toBe(false);
  });

  it('treats * as zero-or-more characters, including slashes', () => {
    expect(albPathPatternMatches('/api/*', '/api/')).toBe(true);
    expect(albPathPatternMatches('/api/*', '/api/v1/users')).toBe(true);
    expect(albPathPatternMatches('/api/*', '/api')).toBe(false); // needs the trailing slash + 0 chars
    expect(albPathPatternMatches('/api*', '/api')).toBe(true); // 0 chars after the prefix
    expect(albPathPatternMatches('*', '/anything/at/all')).toBe(true);
  });

  it('treats ? as exactly one character', () => {
    expect(albPathPatternMatches('/img?', '/imgs')).toBe(true);
    expect(albPathPatternMatches('/img?', '/img')).toBe(false);
    expect(albPathPatternMatches('/img?', '/imgss')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(albPathPatternMatches('/API/*', '/api/x')).toBe(false);
    expect(albPathPatternMatches('/API/*', '/API/x')).toBe(true);
  });

  it('matches the path only, ignoring the query string', () => {
    expect(albPathPatternMatches('/search', '/search?q=hello')).toBe(true);
    expect(albPathPatternMatches('/search', '/search#frag')).toBe(true);
  });

  it('escapes regex metacharacters in the literal portion', () => {
    expect(albPathPatternMatches('/a.b', '/a.b')).toBe(true);
    expect(albPathPatternMatches('/a.b', '/axb')).toBe(false); // '.' is literal, not "any char"
  });
});

describe('albHostPatternMatches', () => {
  it('matches a literal host case-insensitively', () => {
    expect(albHostPatternMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(albHostPatternMatches('api.example.com', 'API.EXAMPLE.COM')).toBe(true);
    expect(albHostPatternMatches('API.example.com', 'api.example.com')).toBe(true);
    expect(albHostPatternMatches('api.example.com', 'web.example.com')).toBe(false);
  });

  it('strips the :port suffix from the request host before matching', () => {
    expect(albHostPatternMatches('api.example.com', 'api.example.com:8080')).toBe(true);
    expect(albHostPatternMatches('api.example.com', 'api.example.com:443')).toBe(true);
  });

  it('treats * / ? as wildcards (subdomain / single-char)', () => {
    expect(albHostPatternMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(albHostPatternMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(albHostPatternMatches('*.example.com', 'example.com')).toBe(false); // needs a subdomain
    expect(albHostPatternMatches('img?.example.com', 'img1.example.com')).toBe(true);
    expect(albHostPatternMatches('img?.example.com', 'img.example.com')).toBe(false);
  });

  it('escapes the literal dots (not "any char")', () => {
    expect(albHostPatternMatches('a.example.com', 'axexample.com')).toBe(false);
  });

  it('strips the port from an IPv6 literal host', () => {
    expect(albHostPatternMatches('[::1]', '[::1]:8080')).toBe(true);
  });
});

describe('matchAlbPathRule', () => {
  const rules: AlbPathRule<string>[] = [
    { priority: 20, pathPatterns: ['/api/*'], target: 'api' },
    { priority: 10, pathPatterns: ['/api/admin/*'], target: 'admin' },
    { priority: 30, pathPatterns: ['/static/*', '/assets/*'], target: 'static' },
  ];

  it('returns the highest-priority (lowest number) matching rule', () => {
    // Both /api/admin/* (priority 10) and /api/* (priority 20) match; 10 wins.
    expect(matchAlbPathRule('/api/admin/users', rules)).toBe('admin');
    expect(matchAlbPathRule('/api/orders', rules)).toBe('api');
  });

  it('evaluates priority irrespective of input order', () => {
    const shuffled = [rules[1]!, rules[2]!, rules[0]!];
    expect(matchAlbPathRule('/api/admin/x', shuffled)).toBe('admin');
  });

  it('OR-matches a rule with multiple path-pattern values', () => {
    expect(matchAlbPathRule('/static/app.js', rules)).toBe('static');
    expect(matchAlbPathRule('/assets/logo.png', rules)).toBe('static');
  });

  it('returns undefined when no rule matches (caller uses the default)', () => {
    expect(matchAlbPathRule('/', rules)).toBeUndefined();
    expect(matchAlbPathRule('/health', rules)).toBeUndefined();
  });

  it('strips the query string before matching', () => {
    expect(matchAlbPathRule('/api/orders?page=2', rules)).toBe('api');
  });

  it('accepts a bare path string (path-only form, no Host)', () => {
    expect(matchAlbPathRule('/api/orders', rules)).toBe('api');
  });
});

describe('matchAlbPathRule with host-header conditions', () => {
  const rules: AlbPathRule<string>[] = [
    // host-only rule
    { priority: 10, pathPatterns: [], hostPatterns: ['api.example.com'], target: 'api-host' },
    // host AND path rule (both must match)
    {
      priority: 5,
      pathPatterns: ['/admin/*'],
      hostPatterns: ['api.example.com'],
      target: 'api-admin',
    },
    // path-only rule
    { priority: 30, pathPatterns: ['/static/*'], target: 'static' },
  ];

  it('matches a host-only rule against the Host header', () => {
    expect(matchAlbPathRule({ path: '/anything', host: 'api.example.com' }, rules)).toBe('api-host');
  });

  it('matches the AND rule only when both host and path match (priority 5 wins)', () => {
    expect(matchAlbPathRule({ path: '/admin/users', host: 'api.example.com' }, rules)).toBe(
      'api-admin'
    );
    // Path matches the AND rule but host does not -> falls to no match (no other rule fits).
    expect(matchAlbPathRule({ path: '/admin/users', host: 'web.example.com' }, rules)).toBeUndefined();
  });

  it('does not match a host-constrained rule when no Host header is present', () => {
    expect(matchAlbPathRule({ path: '/anything' }, rules)).toBeUndefined();
    // A path-only rule still matches without a Host header.
    expect(matchAlbPathRule({ path: '/static/app.js' }, rules)).toBe('static');
  });

  it('matches the Host header case-insensitively and ignores the :port', () => {
    expect(matchAlbPathRule({ path: '/', host: 'API.EXAMPLE.COM:8080' }, rules)).toBe('api-host');
  });
});

describe('httpHeaderConditionMatches', () => {
  it('looks up the header case-insensitively', () => {
    expect(
      httpHeaderConditionMatches({ name: 'X-Tenant', values: ['acme'] }, { 'x-tenant': 'acme' })
    ).toBe(true);
    expect(
      httpHeaderConditionMatches({ name: 'X-TENANT', values: ['acme'] }, { 'X-Tenant': 'acme' })
    ).toBe(true);
  });

  it('OR-matches the value globs (case-insensitive value comparison)', () => {
    const cond = { name: 'X-Plan', values: ['ENTERPRISE', 'team*'] };
    expect(httpHeaderConditionMatches(cond, { 'x-plan': 'enterprise' })).toBe(true);
    expect(httpHeaderConditionMatches(cond, { 'x-plan': 'TEAM-LITE' })).toBe(true);
    expect(httpHeaderConditionMatches(cond, { 'x-plan': 'free' })).toBe(false);
  });

  it('matches when ANY value of a multi-valued header satisfies the glob', () => {
    const cond = { name: 'Accept', values: ['application/json'] };
    expect(httpHeaderConditionMatches(cond, { accept: ['text/html', 'application/json'] })).toBe(
      true
    );
    expect(httpHeaderConditionMatches(cond, { accept: ['text/html'] })).toBe(false);
  });

  it('returns false when the header is missing or the headers dict is undefined', () => {
    expect(httpHeaderConditionMatches({ name: 'X-Tenant', values: ['*'] }, undefined)).toBe(false);
    expect(httpHeaderConditionMatches({ name: 'X-Tenant', values: ['*'] }, {})).toBe(false);
  });
});

describe('queryStringConditionMatches', () => {
  it('matches a Key+Value pair (case-insensitive)', () => {
    expect(
      queryStringConditionMatches({ key: 'Version', value: '2' }, [{ key: 'version', value: '2' }])
    ).toBe(true);
    expect(
      queryStringConditionMatches({ key: 'version', value: 'V2' }, [{ key: 'version', value: 'v2' }])
    ).toBe(true);
  });

  it('honors * / ? wildcards in both Key and Value', () => {
    expect(
      queryStringConditionMatches({ key: 'tag-*', value: 'beta*' }, [
        { key: 'tag-rollout', value: 'beta-3' },
      ])
    ).toBe(true);
    expect(
      queryStringConditionMatches({ key: 'tag-?', value: '?' }, [{ key: 'tag-x', value: 'b' }])
    ).toBe(true);
  });

  it('matches ANY key when Key is omitted', () => {
    const cond = { value: 'beta' };
    expect(queryStringConditionMatches(cond, [{ key: 'flag', value: 'beta' }])).toBe(true);
    expect(queryStringConditionMatches(cond, [{ key: 'other', value: 'beta' }])).toBe(true);
    expect(queryStringConditionMatches(cond, [{ key: 'flag', value: 'alpha' }])).toBe(false);
  });

  it('returns false when no parameter matches', () => {
    expect(
      queryStringConditionMatches({ key: 'v', value: '1' }, [{ key: 'v', value: '2' }])
    ).toBe(false);
    expect(queryStringConditionMatches({ key: 'v', value: '1' }, [])).toBe(false);
  });
});

describe('albCidrMatches', () => {
  it('matches an IPv4 address inside a /24', () => {
    expect(albCidrMatches('192.0.2.0/24', '192.0.2.42')).toBe(true);
    expect(albCidrMatches('192.0.2.0/24', '192.0.3.1')).toBe(false);
  });

  it('matches an exact IPv4 with /32', () => {
    expect(albCidrMatches('192.0.2.42/32', '192.0.2.42')).toBe(true);
    expect(albCidrMatches('192.0.2.42/32', '192.0.2.43')).toBe(false);
  });

  it('matches the full IPv4 range with /0', () => {
    expect(albCidrMatches('0.0.0.0/0', '8.8.8.8')).toBe(true);
  });

  it('matches an IPv6 address inside a /32', () => {
    expect(albCidrMatches('2001:db8::/32', '2001:db8:1234::1')).toBe(true);
    expect(albCidrMatches('2001:db8::/32', '2001:db9::1')).toBe(false);
  });

  it('matches an IPv6 ::1 inside ::/0', () => {
    expect(albCidrMatches('::/0', '::1')).toBe(true);
  });

  it('does not cross-match IPv4 against IPv6 or vice versa', () => {
    expect(albCidrMatches('192.0.2.0/24', '::1')).toBe(false);
    expect(albCidrMatches('2001:db8::/32', '192.0.2.1')).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(albCidrMatches('not-a-cidr', '192.0.2.1')).toBe(false);
    expect(albCidrMatches('192.0.2.0/33', '192.0.2.1')).toBe(false);
    expect(albCidrMatches('192.0.2.0/24', 'not-an-ip')).toBe(false);
  });
});

describe('matchAlbPathRule with new condition fields', () => {
  it('honors an http-header condition (one rule, OR-matched values)', () => {
    const rules: AlbPathRule<string>[] = [
      {
        priority: 5,
        pathPatterns: [],
        httpHeaderConditions: [{ name: 'X-Tenant', values: ['acme'] }],
        target: 'tenant-acme',
      },
    ];
    expect(matchAlbPathRule({ path: '/', headers: { 'x-tenant': 'acme' } }, rules)).toBe(
      'tenant-acme'
    );
    expect(matchAlbPathRule({ path: '/', headers: { 'x-tenant': 'other' } }, rules)).toBeUndefined();
    expect(matchAlbPathRule({ path: '/' }, rules)).toBeUndefined();
  });

  it('ANDs multiple http-header conditions on one rule', () => {
    const rules: AlbPathRule<string>[] = [
      {
        priority: 5,
        pathPatterns: [],
        httpHeaderConditions: [
          { name: 'X-Tenant', values: ['acme'] },
          { name: 'X-Env', values: ['prod'] },
        ],
        target: 'acme-prod',
      },
    ];
    expect(
      matchAlbPathRule({ path: '/', headers: { 'x-tenant': 'acme', 'x-env': 'prod' } }, rules)
    ).toBe('acme-prod');
    expect(
      matchAlbPathRule({ path: '/', headers: { 'x-tenant': 'acme', 'x-env': 'dev' } }, rules)
    ).toBeUndefined();
  });

  it('honors an http-request-method condition (OR-matched, exact, case-sensitive)', () => {
    const rules: AlbPathRule<string>[] = [
      { priority: 5, pathPatterns: [], httpRequestMethods: ['POST', 'PUT'], target: 'writes' },
    ];
    expect(matchAlbPathRule({ path: '/', method: 'POST' }, rules)).toBe('writes');
    expect(matchAlbPathRule({ path: '/', method: 'PUT' }, rules)).toBe('writes');
    expect(matchAlbPathRule({ path: '/', method: 'GET' }, rules)).toBeUndefined();
    // ALB is case-sensitive uppercase; lower-case is NOT auto-matched.
    expect(matchAlbPathRule({ path: '/', method: 'post' }, rules)).toBeUndefined();
  });

  it('honors a query-string condition (OR-matched Key+Value entries)', () => {
    const rules: AlbPathRule<string>[] = [
      {
        priority: 5,
        pathPatterns: [],
        queryStringConditions: [{ key: 'v', value: '2' }, { value: '*beta*' }],
        target: 'q-match',
      },
    ];
    expect(matchAlbPathRule({ path: '/?v=2' }, rules)).toBe('q-match');
    expect(matchAlbPathRule({ path: '/?flag=mybeta1' }, rules)).toBe('q-match');
    expect(matchAlbPathRule({ path: '/?v=1' }, rules)).toBeUndefined();
    expect(matchAlbPathRule({ path: '/' }, rules)).toBeUndefined();
  });

  it('decodes percent-encoded query parameters before matching', () => {
    const rules: AlbPathRule<string>[] = [
      {
        priority: 5,
        pathPatterns: [],
        queryStringConditions: [{ key: 'name', value: 'a b' }],
        target: 'q-decoded',
      },
    ];
    expect(matchAlbPathRule({ path: '/?name=a%20b' }, rules)).toBe('q-decoded');
    expect(matchAlbPathRule({ path: '/?name=a+b' }, rules)).toBe('q-decoded');
  });

  it('honors a source-ip condition (OR-matched CIDRs, IPv4 + IPv6)', () => {
    const rules: AlbPathRule<string>[] = [
      {
        priority: 5,
        pathPatterns: [],
        sourceIpCidrs: ['10.0.0.0/8', '2001:db8::/32'],
        target: 'internal',
      },
    ];
    expect(matchAlbPathRule({ path: '/', sourceIp: '10.1.2.3' }, rules)).toBe('internal');
    expect(matchAlbPathRule({ path: '/', sourceIp: '2001:db8:42::1' }, rules)).toBe('internal');
    expect(matchAlbPathRule({ path: '/', sourceIp: '8.8.8.8' }, rules)).toBeUndefined();
    expect(matchAlbPathRule({ path: '/' }, rules)).toBeUndefined();
  });

  it('unmaps an IPv4-mapped IPv6 source IP (::ffff:127.0.0.1) for IPv4 CIDR matching', () => {
    const rules: AlbPathRule<string>[] = [
      { priority: 5, pathPatterns: [], sourceIpCidrs: ['127.0.0.0/8'], target: 'loopback' },
    ];
    expect(matchAlbPathRule({ path: '/', sourceIp: '::ffff:127.0.0.1' }, rules)).toBe('loopback');
  });

  it('ANDs path-pattern + http-header + http-request-method + query-string + source-ip on one rule', () => {
    const rules: AlbPathRule<string>[] = [
      {
        priority: 5,
        pathPatterns: ['/api/*'],
        httpHeaderConditions: [{ name: 'X-API', values: ['v2'] }],
        httpRequestMethods: ['POST'],
        queryStringConditions: [{ key: 'v', value: '1' }],
        sourceIpCidrs: ['10.0.0.0/8'],
        target: 'full-match',
      },
    ];
    expect(
      matchAlbPathRule(
        {
          path: '/api/x?v=1',
          method: 'POST',
          headers: { 'x-api': 'v2' },
          sourceIp: '10.1.2.3',
        },
        rules
      )
    ).toBe('full-match');
    // Drop just the method -> the rule no longer matches.
    expect(
      matchAlbPathRule(
        {
          path: '/api/x?v=1',
          method: 'GET',
          headers: { 'x-api': 'v2' },
          sourceIp: '10.1.2.3',
        },
        rules
      )
    ).toBeUndefined();
  });
});
