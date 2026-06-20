import { describe, expect, it } from 'vitest';

import { buildContractIndex, instrumentContractCollection, parseOpenApiDocument } from '../src/contract.js';

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
    expect(JSON.stringify(event)).toContain('Status code is defined by OpenAPI');
    expect(result.warnings).toEqual([]);
  });
});
