import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "sessionbox" },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      // WebSocket clients pass the bearer token as a query parameter; never
      // let it reach the logs.
      req(request: { method?: string; url?: string; ip?: string }) {
        return {
          method: request.method,
          url: redactToken(request.url),
          remoteAddress: request.ip,
        };
      },
    },
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}

export function redactToken(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;

  return url.replace(/([?&]token=)[^&]*/gi, "$1[redacted]");
}
