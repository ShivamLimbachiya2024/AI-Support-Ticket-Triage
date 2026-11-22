import { Response } from 'express';

interface GeneralResponseOptions {
  response: Response;
  data?: unknown;
  message: string;
  responseType?: 'success' | 'error';
  toast?: boolean;
  statusCode?: number;
}

const generalResponse = (resObject: GeneralResponseOptions): void => {
  const {
    response,
    data = [],
    message = '',
    responseType = 'success',
    toast = false,
    statusCode = 200,
  } = resObject;
  response.status(statusCode).json({
    data,
    message,
    toast,
    response_type: responseType,
  });
};

export default generalResponse;
