import { Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import User from '../../../sequelize/models/users.modal';
import { AuthRequest } from '../../../middleware';
import { JWT_SECRET } from '../../../config';
import { USER_ROLE } from '../enum/role';
export const registerUser = async (req: AuthRequest, res: Response) => {
  const { first_name: firstName, last_name: lastName, email, phone, password } = req.body;
  if (await User.findOne({ where: { email } })) {
    res.status(409).json({ message: 'Email already registered' });
    return;
  }
  const user = await User.create({
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    password_hash: await argon2.hash(password),
    role: USER_ROLE.CUSTOMER,
  });

  res.status(201).json({ id: user.id, email: user.email, role: user.role });
};
export const loginUser = async (req: AuthRequest, res: Response) => {
  const user = await User.findOne({ where: { email: req.body.email } });
  if (!user || !(await argon2.verify(user.password_hash, req.body.password))) {
    res.status(401).json({ message: 'Invalid credentials' });
    return;
  }
  const token = jwt.sign({ id: Number(user.id), role: user.role }, JWT_SECRET, { expiresIn: '1d' });
  res
    .cookie('token', token, { httpOnly: true, sameSite: 'strict' })
    .json({ id: user.id, role: user.role });
};
export const isLoggedInUser = async (req: AuthRequest, res: Response) => {
  res.json({ id: req.userId, role: req.role });
};
