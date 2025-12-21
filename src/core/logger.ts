import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { config } from '../utils/config';
import { LOG_CONSTANTS } from '../utils/constants';
import { LogMetadata } from '../types';

/**
 * Creates and configures the Winston logger instance
 */
class Logger {
  private logger: winston.Logger;

  constructor() {
    const logDir = config.system.logDir;

    // Custom format for structured logging
    const customFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    );

    // Console format for better readability
    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let log = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(meta).length > 0) {
          log += ` ${JSON.stringify(meta)}`;
        }
        return log;
      })
    );

    // Create transports
    const transports: winston.transport[] = [
      // Console transport
      new winston.transports.Console({
        format: consoleFormat,
        level: config.system.logLevel,
      }),

      // General log file with rotation
      new DailyRotateFile({
        filename: path.join(logDir, 'application-%DATE%.log'),
        datePattern: LOG_CONSTANTS.DATE_PATTERN,
        maxSize: LOG_CONSTANTS.MAX_FILE_SIZE,
        maxFiles: LOG_CONSTANTS.MAX_FILES,
        format: customFormat,
        level: 'info',
      }),

      // Error log file
      new DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: LOG_CONSTANTS.DATE_PATTERN,
        maxSize: LOG_CONSTANTS.MAX_FILE_SIZE,
        maxFiles: LOG_CONSTANTS.MAX_FILES,
        format: customFormat,
        level: 'error',
      }),

      // Trade decisions log file
      new DailyRotateFile({
        filename: path.join(logDir, 'trades-%DATE%.log'),
        datePattern: LOG_CONSTANTS.DATE_PATTERN,
        maxSize: LOG_CONSTANTS.MAX_FILE_SIZE,
        maxFiles: LOG_CONSTANTS.MAX_FILES,
        format: customFormat,
        level: 'info',
      }),
    ];

    // Create logger instance
    this.logger = winston.createLogger({
      level: config.system.logLevel,
      format: customFormat,
      transports,
      exitOnError: false,
    });
  }

  /**
   * Log info level message
   */
  info(message: string, meta?: LogMetadata): void {
    this.logger.info(message, meta);
  }

  /**
   * Log warning level message
   */
  warn(message: string, meta?: LogMetadata): void {
    this.logger.warn(message, meta);
  }

  /**
   * Log error level message
   */
  error(message: string, error?: Error | unknown, meta?: LogMetadata): void {
    const errorMeta = {
      ...meta,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name,
      } : error,
    };
    this.logger.error(message, errorMeta);
  }

  /**
   * Log debug level message
   */
  debug(message: string, meta?: LogMetadata): void {
    this.logger.debug(message, meta);
  }

  /**
   * Log trade decision
   */
  trade(message: string, meta: LogMetadata): void {
    this.logger.info(message, { ...meta, type: 'trade' });
  }

  /**
   * Log AI decision
   */
  aiDecision(message: string, meta: LogMetadata): void {
    this.logger.info(message, { ...meta, type: 'ai_decision' });
  }

  /**
   * Log order execution
   */
  order(message: string, meta: LogMetadata): void {
    this.logger.info(message, { ...meta, type: 'order' });
  }

  /**
   * Log performance metrics
   */
  metrics(message: string, meta: LogMetadata): void {
    this.logger.info(message, { ...meta, type: 'metrics' });
  }

  /**
   * Create a child logger with additional default metadata
   */
  child(defaultMeta: LogMetadata): Logger {
    const childLogger = new Logger();
    childLogger.logger = this.logger.child(defaultMeta);
    return childLogger;
  }
}

// Export singleton instance
export const logger = new Logger();
export default logger;
