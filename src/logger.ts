import pino from 'pino';

/**
 * Structured logger. Reads `LOG_LEVEL` straight from the environment (default
 * `info`) rather than importing `config` — that keeps `logger` free of the
 * config module's fail-fast validation, so pure modules and unit tests can
 * import it without a fully-populated `.env`.
 */
const level = process.env.LOG_LEVEL?.trim() || 'info';

export const logger = pino({
  level,
  ...(process.env.NODE_ENV === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
});
