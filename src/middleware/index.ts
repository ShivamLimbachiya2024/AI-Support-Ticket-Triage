import { NextFunction, Request, Response } from 'express';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { logger } from '../logger';
import User from '../sequelize/models/users.modal';
export interface AuthRequest extends Request {
  userId?: number;
  role?: string;
  userEmail?: string;
  validatedQuery?: unknown;
}
export const validate =
  (schema: Joi.ObjectSchema, source: 'body' | 'params' = 'body') =>
  (req: Request, res: Response, next: NextFunction) => {
    const input = source === 'body' ? req.body : req.params;
    const { error, value } = schema.validate(input, { abortEarly: false, stripUnknown: true });
    if (error) {
      res.status(400).json({ message: error.message });
      return;
    }

    if (source === 'body') req.body = value;
    if (source === 'params') req.params = value;
    next();
  };

export const validateQuery =
  (schema: Joi.ObjectSchema) => (req: AuthRequest, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      convert: true,
      allowUnknown: false,
    });

    if (error) {
      res.status(400).json({ message: error.message });
      return;
    }

    req.validatedQuery = value;
    next();
  };

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ message: 'Authentication required' });
    return;
  }
  let payload: { id: number; role: string };
  try {
    payload = jwt.verify(token, JWT_SECRET) as { id: number; role: string };
  } catch {
    res.status(401).json({ message: 'Invalid token' });
    return;
  }
  const user = await User.findByPk(payload.id);
  if (!user) {
    res.status(401).json({ message: 'Account not found' });
    return;
  }
  req.userId = Number(user.id);
  req.role = user.role;
  req.userEmail = user.email;
  next();
};
export const requestLog = (req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  res.on('finish', () =>
    logger.info(
      req.method +
        ' ' +
        req.originalUrl +
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
  logger.error(req.method + ' ' + req.originalUrl + ' failed: ' + error.message);
  if (!res.headersSent) res.status(500).json({ message: 'Internal server error' });
};
