import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import generalResponse from '../helper';
import { logger } from '../logger';
import User from '../sequelize/models/users.modal';
export interface AuthRequest extends Request {
  requestId?: string;
  userId?: number;
  role?: string;
  userEmail?: string;
  validatedQuery?: unknown;
}
export const validate =
  (schema: Joi.ObjectSchema, source: 'body' | 'params' = 'body') =>
  (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req as AuthRequest).requestId ?? 'unknown';
    let input = req.body;
    if (source === 'params') input = req.params;
    logger.info(`Request ${requestId} ${source} validation started`);
    const { error, value } = schema.validate(input, { abortEarly: false, stripUnknown: true });
    if (error) {
      logger.warn(
        `Request ${requestId} ${source} validation failed with ${error.details.length} issue(s)`
      );
      generalResponse({
        response: res,
        message: error.message,
        responseType: 'error',
        statusCode: 400,
      });
      return;
    }

    if (source === 'body') req.body = value;
    if (source === 'params') req.params = value;
    logger.info(`Request ${requestId} ${source} validation completed successfully`);
    next();
  };

export const validateQuery =
  (schema: Joi.ObjectSchema) => (req: AuthRequest, res: Response, next: NextFunction) => {
    const requestId = req.requestId ?? 'unknown';
    logger.info(`Request ${requestId} query validation started`);
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      convert: true,
      allowUnknown: false,
    });

    if (error) {
      logger.warn(
        `Request ${requestId} query validation failed with ${error.details.length} issue(s)`
      );
      generalResponse({
        response: res,
        message: error.message,
        responseType: 'error',
        statusCode: 400,
      });
      return;
    }

    req.validatedQuery = value;
    logger.info(`Request ${requestId} query validation completed successfully`);
    next();
  };

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const requestId = req.requestId ?? 'unknown';
  logger.info(`Request ${requestId} authentication started`);
  let token = req.cookies?.token;
  if (!token) token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    logger.warn(`Request ${requestId} authentication rejected because no token was provided`);
    generalResponse({
      response: res,
      message: 'Authentication required',
      responseType: 'error',
      statusCode: 401,
    });
    return;
  }
  let payload: { id: number; role: string };
  logger.info(`Request ${requestId} authentication token verification started`);
  try {
    payload = jwt.verify(token, JWT_SECRET) as { id: number; role: string };
  } catch {
    logger.warn(`Request ${requestId} authentication rejected because the token was invalid`);
    generalResponse({
      response: res,
      message: 'Invalid token',
      responseType: 'error',
      statusCode: 401,
    });
    return;
  }
  logger.info(`Request ${requestId} token verified; loading account ${payload.id}`);
  const user = await User.findByPk(payload.id);
  if (!user) {
    logger.warn(
      `Request ${requestId} authentication rejected because account ${payload.id} was not found`
    );
    generalResponse({
      response: res,
      message: 'Account not found',
      responseType: 'error',
      statusCode: 401,
    });
    return;
  }
  req.userId = Number(user.id);
  req.role = user.role;
  req.userEmail = user.email;
  logger.info(`Request ${requestId} authenticated as user ${req.userId} with role ${req.role}`);
  next();
};
export const requestLog = (req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  const requestId = randomUUID();
  (req as AuthRequest).requestId = requestId;
  res.setHeader('x-request-id', requestId);
  logger.info(`Request ${requestId} received: ${req.method} ${req.path} from ${req.ip}`);
  res.on('finish', () =>
    logger.info(
      'Request ' +
        requestId +
        ' completed: ' +
        req.method +
        ' ' +
        req.path +
        ' from ' +
        req.ip +
        ' returned ' +
        res.statusCode +
        ' in ' +
        (Date.now() - started) +
        'ms'
    )
  );
  next();
};
export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  nextFunction: NextFunction
) => {
  const requestId = (req as AuthRequest).requestId ?? 'unknown';
  logger.error(`Request ${requestId} ${req.method} ${req.path} failed: ${error.message}`);
  if (!res.headersSent) {
    generalResponse({
      response: res,
      message: 'Internal server error',
      responseType: 'error',
      statusCode: 500,
    });
  }
};

export const notFoundHandler = (req: Request, res: Response) => {
  const requestId = (req as AuthRequest).requestId ?? 'unknown';
  logger.warn(`Request ${requestId} route not found: ${req.method} ${req.path}`);
  generalResponse({
    response: res,
    message: 'Route not found',
    responseType: 'error',
    statusCode: 404,
  });
};
