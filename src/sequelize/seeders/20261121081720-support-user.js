'use strict';
const argon2 = require('argon2');
module.exports = {
  async up(queryInterface) {
    const email = process.env.SUPPORT_EMAIL;
    const password = process.env.SUPPORT_PASSWORD;
    if (!email || !password) throw new Error('SUPPORT_EMAIL and SUPPORT_PASSWORD are required');
    const existing = await queryInterface.rawSelect('users', { where: { email } }, ['id']);
    if (existing) return;
    await queryInterface.bulkInsert('users', [
      {
        first_name: 'Support',
        last_name: 'Agent',
        email,
        password_hash: await argon2.hash(password),
        role: 'support',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },
  async down(queryInterface) {
    const email = process.env.SUPPORT_EMAIL;
    if (!email) throw new Error('SUPPORT_EMAIL is required');
    await queryInterface.bulkDelete('users', { email });
  },
};
