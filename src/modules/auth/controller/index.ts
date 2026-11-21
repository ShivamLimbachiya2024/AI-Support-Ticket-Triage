import { Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import User from '../../../sequelize/models/users.modal';
import { AuthRequest } from '../../../middleware';
import { JWT_SECRET } from '../../../config';
import { USER_ROLE } from '../enum/role';
import { logger } from '../../../logger';

export const registerUser = async (req: AuthRequest, res: Response) => {
  const { first_name: firstName, last_name: lastName, email, phone, password } = req.body;
  const requestId = req.requestId ?? 'unknown';
  logger.info(`Request ${requestId} account registration started`);

  logger.info(`Request ${requestId} checking whether the account email is already registered`);
  const existingUser = await User.findOne({ where: { email } });
  logger.info(
    `Request ${requestId} account email lookup completed: ${existingUser ? 'already registered' : 'available'}`
  );

  if (existingUser) {
    logger.warn(
      `Request ${requestId} registration rejected because the account email is already registered`
    );
    res.status(409).json({ message: 'Email already registered' });
    return;
  }

  logger.info(`Request ${requestId} password hashing started`);
  const passwordHash = await argon2.hash(password);
  logger.info(`Request ${requestId} password hashing completed`);

  logger.info(`Request ${requestId} creating a customer account`);
  const user = await User.create({
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    password_hash: passwordHash,
    role: USER_ROLE.CUSTOMER,
  });
  logger.info(`Request ${requestId} customer account ${user.id} created successfully`);

  logger.info(`Request ${requestId} account registration completed for user ${user.id}`);
  res.status(201).json({ id: user.id, email: user.email, role: user.role });
};
export const loginUser = async (req: AuthRequest, res: Response) => {
  const requestId = req.requestId ?? 'unknown';
  logger.info(`Request ${requestId} login started`);
  logger.info(`Request ${requestId} account lookup for login started`);
  const user = await User.findOne({ where: { email: req.body.email } });
  logger.info(`Request ${requestId} account lookup for login completed`);

  if (!user) {
    logger.warn(`Request ${requestId} login rejected because credentials were invalid`);
    res.status(401).json({ message: 'Invalid credentials' });
    return;
  }

  logger.info(`Request ${requestId} password verification started for user ${user.id}`);
  const passwordMatches = await argon2.verify(user.password_hash, req.body.password);
  logger.info(`Request ${requestId} password verification completed for user ${user.id}`);

  if (!passwordMatches) {
    logger.warn(`Request ${requestId} login rejected because credentials were invalid`);
    res.status(401).json({ message: 'Invalid credentials' });
    return;
  }

  logger.info(`Request ${requestId} access token creation started for user ${user.id}`);
  const token = jwt.sign({ id: Number(user.id), role: user.role }, JWT_SECRET, { expiresIn: '1d' });
  logger.info(`Request ${requestId} access token created for user ${user.id}`);

  res
    .cookie('token', token, { httpOnly: true, sameSite: 'strict' })
    .json({ id: user.id, role: user.role });
  logger.info(`Request ${requestId} login completed for user ${user.id}`);
};
export const isLoggedInUser = async (req: AuthRequest, res: Response) => {
  const requestId = req.requestId ?? 'unknown';
  logger.info(
    `Request ${requestId} authenticated account details requested for user ${req.userId}`
  );
  res.json({ id: req.userId, role: req.role });
  logger.info(`Request ${requestId} authenticated account details returned for user ${req.userId}`);
};
