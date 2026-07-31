import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '@postman-cse/automation-core';

import { PostmanClient } from '../src/postman/client.js';

describe('PostmanClient shared HttpError compatibility', () => {
  it('preserves the released status, message, and masking format', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('upstream rejected PMAK-secret', {
        status: 503,
        statusText: 'Service Unavailable'
      })
    );
    const client = new PostmanClient({
      apiKey: 'PMAK-secret',
      baseUrl: 'https://api.getpostman.com',
      fetchImpl
    });

    const request = client.request('/workspaces', { method: 'POST' });
    await expect(request).rejects.toBeInstanceOf(HttpError);
    await expect(request).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
      message:
        'POST https://api.getpostman.com/workspaces failed with 503 Service Unavailable: upstream rejected ***'
    });
  });
});
