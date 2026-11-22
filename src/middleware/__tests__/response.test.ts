import type { Response } from 'express';
import { AuthRequest, errorHandler, notFoundHandler } from '../index';

test('returns 400 for malformed JSON request bodies', () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status, headersSent: false } as unknown as Response;
  const request = {
    method: 'POST',
    path: '/api/tickets',
    requestId: 'request-1',
  } as AuthRequest;
  const error = Object.assign(new SyntaxError('Invalid JSON'), {
    status: 400,
    type: 'entity.parse.failed',
  });

  errorHandler(error, request, response, jest.fn());

  expect(status).toHaveBeenCalledWith(400);
  expect(json).toHaveBeenCalledWith({
    data: [],
    message: 'Malformed JSON request body',
    toast: false,
    response_type: 'error',
  });
});

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
