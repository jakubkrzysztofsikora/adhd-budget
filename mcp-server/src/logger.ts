import pino from 'pino';

export function createLogger() {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    // Never log tokens, secrets, or financial PII
    redact: ['req.headers.authorization', 'token', 'accessToken', 'refreshToken', 'privateKey'],
  });
}
