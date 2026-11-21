import dotenv from 'dotenv';

dotenv.config();

// Keep environment variables together and defer mode-specific requirements until startup.
const environment = {
  appMode: process.env.APP_MODE,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  port: process.env.PORT,
  frontUrl: process.env.FRONT_URL,
  rabbitMqHost: process.env.RABBITMQ_HOST,
  rabbitMqUser: process.env.RABBITMQ_USER,
  rabbitMqPassword: process.env.RABBITMQ_PASSWORD,
  consumerTopic: process.env.CONSUMER_TOPIC,
  modelProvider: process.env.MODEL_PROVIDER,
  modelName: process.env.MODEL_NAME,
  embeddingModel: process.env.EMBEDDING_MODEL,
  promptVersion: process.env.PROMPT_VERSION,
  geminiApiKey: process.env.GEMINI_API_KEY,
};

export const requireValue = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`Environment variable ${name} is required`);

  return value;
};

export const required = (name: string): string => requireValue(name, process.env[name]);

export const APP_MODE = requireValue('APP_MODE', environment.appMode);
export const DATABASE_URL = requireValue('DATABASE_URL', environment.databaseUrl);
export const JWT_SECRET = requireValue('JWT_SECRET', environment.jwtSecret);
export const PORT = Number(requireValue('PORT', environment.port));
export const FRONT_URL = requireValue('FRONT_URL', environment.frontUrl);
export const RABBITMQ_HOST = requireValue('RABBITMQ_HOST', environment.rabbitMqHost);
export const RABBITMQ_USER = requireValue('RABBITMQ_USER', environment.rabbitMqUser);
export const RABBITMQ_PASSWORD = requireValue('RABBITMQ_PASSWORD', environment.rabbitMqPassword);
export const MODEL_PROVIDER = requireValue('MODEL_PROVIDER', environment.modelProvider);
export const MODEL_NAME = requireValue('MODEL_NAME', environment.modelName);
export const EMBEDDING_MODEL = requireValue('EMBEDDING_MODEL', environment.embeddingModel);
const configured_prompt_version = requireValue('PROMPT_VERSION', environment.promptVersion);
export const PROMPT_VERSION = `${configured_prompt_version}-verified-v2`;
export const CONSUMER_TOPIC = environment.consumerTopic;
export const GEMINI_API_KEY = environment.geminiApiKey;

if (APP_MODE !== 'api' && APP_MODE !== 'worker') {
  throw new Error('APP_MODE must be api or worker');
}

if (MODEL_PROVIDER !== 'fake' && MODEL_PROVIDER !== 'gemini') {
  throw new Error('MODEL_PROVIDER must be fake or gemini');
}

if (APP_MODE === 'worker') requireValue('CONSUMER_TOPIC', CONSUMER_TOPIC);
if (MODEL_PROVIDER === 'gemini') requireValue('GEMINI_API_KEY', GEMINI_API_KEY);
