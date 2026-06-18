import dotenv from 'dotenv';
dotenv.config();

export const {
  PORT,
  MONGO_URI,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN,
  BCRYPT_SALT_ROUNDS,
  EMAIL_HOST,
  EMAIL_PORT,
  EMAIL_USER,
  EMAIL_PASS,
  CLIENT_URL,
} = process.env;