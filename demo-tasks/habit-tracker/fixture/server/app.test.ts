import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('createApp', () => {
  it('responds to GET /api/health', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
