import { describe, expect, it } from 'vitest';

import { buildContractIndex, instrumentContractCollection, parseOpenApiDocument } from '../src/contract.js';

interface ExpectationChain {
  readonly and: ExpectationChain;
  readonly be: ExpectationChain;
  readonly empty: ExpectationChain;
  readonly exist: ExpectationChain;
  readonly not: ExpectationChain;
  readonly to: ExpectationChain;
  a(type: string): ExpectationChain;
  above(expected: number): ExpectationChain;
  equal(expected: unknown): ExpectationChain;
}

function createExpectation(actual: unknown, message?: string): ExpectationChain {
  let negate = false;
  // Self-referential: the closure below captures `chain` before its single assignment.
  // eslint-disable-next-line prefer-const
  let chain: ExpectationChain;
  const assert = (condition: boolean, defaultMessage: string): ExpectationChain => {
    const passed = negate ? !condition : condition;
    negate = false;
    if (!passed) throw new Error(message || defaultMessage);
    return chain;
  };
  chain = {
    get and() { return chain; },
    get be() { return chain; },
    get empty() {
      const length = typeof actual === 'string' || Array.isArray(actual) ? actual.length : undefined;
      return assert(length === 0, `expected ${String(actual)} to be empty`);
    },
    get exist() { return assert(actual !== undefined && actual !== null, 'expected value to exist'); },
    get not() {
      negate = !negate;
      return chain;
    },
    get to() { return chain; },
    a(type: string) {
      const actualType = Array.isArray(actual) ? 'array' : typeof actual;
      return assert(actualType === type, `expected ${actualType} to be ${type}`);
    },
    above(expected: number) {
      return assert(typeof actual === 'number' && actual > expected, `expected ${String(actual)} to be above ${expected}`);
    },
    equal(expected: unknown) {
      return assert(actual === expected, `expected ${String(actual)} to equal ${String(expected)}`);
    }
  };
  return chain;
}

function runGeneratedScript(script: string[], options: {
  body: string;
  code: number;
  contentType: string;
}): string[] {
  const failures: string[] = [];
  const expectFn = ((actual: unknown, message?: string) => createExpectation(actual, message)) as
    ((actual: unknown, message?: string) => ExpectationChain) & { fail(message: string): never };
  expectFn.fail = (message: string): never => {
    throw new Error(message);
  };
  const pm = {
    expect: expectFn,
    response: {
      code: options.code,
      headers: {
        get: (name: string) => name.toLowerCase() === 'content-type' ? options.contentType : undefined
      },
      text: () => options.body
    },
    test: (_name: string, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  };
  new Function('pm', script.join('\n'))(pm);
  return failures;
}

describe('contract instrumentation', () => {
  const spec = `
openapi: 3.0.3
info:
  title: Test
  version: 1.0.0
paths:
  /v1/health:
    get:
      operationId: getHealth
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status:
                    type: string
`;

  it('builds an operation index from OpenAPI', () => {
    const index = buildContractIndex(parseOpenApiDocument(spec));
    expect(index.openapiVersion).toBe('3.0');
    expect(index.operations).toMatchObject([
      {
        method: 'GET',
        operationId: 'getHealth',
        path: '/v1/health'
      }
    ]);
  });

  it('injects generated test events into matching collection requests', () => {
    const index = buildContractIndex(parseOpenApiDocument(spec));
    const result = instrumentContractCollection({
      info: { name: 'collection' },
      item: [
        {
          name: 'Health',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/v1/health'
            }
          }
        }
      ]
    }, index);

    const item = (result.collection.item as Array<Record<string, unknown>>)[0]!;
    const event = (item.event as Array<Record<string, unknown>>)[0]!;
    expect(event.listen).toBe('test');
    expect(JSON.stringify(event)).toContain('[Postman TDD]');
    expect(JSON.stringify(event)).toContain('status code is defined by OpenAPI');
    expect(result.warnings).toEqual([]);
  });

  it('enforces string and numeric schema constraints in generated scripts', () => {
    const constraintSpec = `
openapi: 3.0.3
info:
  title: Test
  version: 1.0.0
paths:
  /v1/widgets/{widgetId}:
    get:
      operationId: getWidget
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [name, shortCode, score, rating, count, upper]
                properties:
                  name:
                    type: string
                    minLength: 2
                    pattern: '^A'
                  shortCode:
                    type: string
                    maxLength: 3
                  score:
                    type: number
                    minimum: 1
                  rating:
                    type: number
                    maximum: 5
                  count:
                    type: integer
                    minimum: 0
                    exclusiveMinimum: true
                  upper:
                    type: integer
                    exclusiveMaximum: 10
`;
    const index = buildContractIndex(parseOpenApiDocument(constraintSpec));
    const result = instrumentContractCollection({
      info: { name: 'collection' },
      item: [
        {
          name: 'Get widget',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/v1/widgets/123'
            }
          }
        }
      ]
    }, index);
    const item = (result.collection.item as Array<{
      event?: Array<{ script?: { exec?: string[] } }>;
    }>)[0]!;
    const script = item.event?.[0]?.script?.exec || [];

    const failures = runGeneratedScript(script, {
      body: JSON.stringify({
        count: 0,
        name: 'B',
        rating: 6,
        score: 0,
        shortCode: 'TOO-LONG',
        upper: 10
      }),
      code: 200,
      contentType: 'application/json'
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('$.name expected minLength 2');
    expect(failures[0]).toContain('$.name expected pattern ^A');
    expect(failures[0]).toContain('$.shortCode expected maxLength 3');
    expect(failures[0]).toContain('$.score expected minimum 1');
    expect(failures[0]).toContain('$.rating expected maximum 5');
    expect(failures[0]).toContain('$.count expected exclusiveMinimum 0');
    expect(failures[0]).toContain('$.upper expected exclusiveMaximum 10');

    expect(runGeneratedScript(script, {
      body: JSON.stringify({
        count: 1,
        name: 'Alice',
        rating: 5,
        score: 1,
        shortCode: 'OK',
        upper: 9
      }),
      code: 200,
      contentType: 'application/json'
    })).toEqual([]);
  });
});
