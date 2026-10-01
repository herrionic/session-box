import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "sessionbox" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
