import express from 'express';
import { Request, Response } from 'express';
import router from '../../../router';
import { healthCheck } from '../controller';

jest.mock('../../auth/router', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../tickets/router', () => ({ __esModule: true, default: jest.fn() }));

test('health check returns a successful health response', () => {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);

  healthCheck({} as Request, response as unknown as Response);

  expect(response.status).toHaveBeenCalledWith(200);
  expect(response.json).toHaveBeenCalledWith({
    data: { status: 'ok' },
    message: 'Service is healthy',
    toast: false,
    response_type: 'success',
  });
});

test('GET /health is available through the application router without authentication', async () => {
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Health test server did not start');

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'ok' },
      message: 'Service is healthy',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
