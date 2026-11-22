import { Request, Response } from 'express';
import generalResponse from '../../../helper';

export const healthCheck = (_request: Request, response: Response) => {
  generalResponse({
    response,
    data: { status: 'ok' },
    message: 'Service is healthy',
  });
};
