import { Response } from 'express';

const generalResponse = (resObject: {
  response: Response;
  data?: any;
  message: string;
  responseType?: string;
  toast?: boolean;
  statusCode?: number;
}) => {
  const {
    response,
    data = [],
    message = '',
    responseType = 'success',
    toast = false,
    statusCode = 200,
  } = resObject;
  response.status(statusCode).send({
    data: data,
    message: message,
    toast: toast,
    response_type: responseType,
  });
};

export default generalResponse;
