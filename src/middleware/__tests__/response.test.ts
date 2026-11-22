import type { Response } from 'express';
import { AuthRequest, notFoundHandler } from '../index';

test('returns the shared error envelope for an unmatched route', () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status } as unknown as Response;
  const request = {
    method: 'GET',
    path: '/missing',
    requestId: 'request-1',
  } as AuthRequest;

  notFoundHandler(request, response);

  expect(status).toHaveBeenCalledWith(404);
  expect(json).toHaveBeenCalledWith({
    data: [],
    message: 'Route not found',
    toast: false,
    response_type: 'error',
  });
});
