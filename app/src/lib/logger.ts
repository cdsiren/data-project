type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  private isDevelopment = import.meta.env.DEV;

  private log(level: LogLevel, context: string, ...args: unknown[]): void {
    if (!this.isDevelopment && level === "debug") {
      return;
    }

    const prefix = `[${context}]`;

    switch (level) {
      case "debug":
        console.log(prefix, ...args);
        break;
      case "info":
        console.info(prefix, ...args);
        break;
      case "warn":
        console.warn(prefix, ...args);
        break;
      case "error":
        console.error(prefix, ...args);
        break;
    }
  }

  debug(context: string, ...args: unknown[]): void {
    this.log("debug", context, ...args);
  }

  info(context: string, ...args: unknown[]): void {
    this.log("info", context, ...args);
  }

  warn(context: string, ...args: unknown[]): void {
    this.log("warn", context, ...args);
  }

  error(context: string, ...args: unknown[]): void {
    this.log("error", context, ...args);
  }
}

export const logger = new Logger();
