import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../index';

let app: Express;

beforeAll(async () => {
  app = await createApp();
});

describe('GET /transactions', () => {
  it('returns 200 and transactions data with valid query params', async () => {
    const response = await request(app).get('/transactions?chain=base');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('transactions');
  });

  it('returns 400 for invalid chain query param', async () => {
    const response = await request(app).get('/transactions?chain=invalidChain');
    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('message', 'Invalid chain parameter');
  });

  it('handles missing chain parameter', async () => {
    const response = await request(app).get('/transactions');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('transactions');
  });

  it('respects pagination parameters', async () => {
    const limit = 5;
    const response = await request(app).get(`/transactions?limit=${limit}`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('transactions');
    expect(Array.isArray(response.body.transactions)).toBe(true);
    expect(response.body.transactions.length).toBeLessThanOrEqual(limit);
  });
});
