require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('Environment variable DATABASE_URL is required');
}

module.exports = {
  development: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
  },
};
