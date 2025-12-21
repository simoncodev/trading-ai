/**
 * Application-wide constants
 */

// Time intervals in milliseconds
export const TIME_INTERVALS = {
  '1s': 1 * 1000,        // 1 second (ultra-aggressive)
  '5s': 5 * 1000,        // 5 seconds
  '10s': 10 * 1000,      // 10 seconds
  '15s': 15 * 1000,      // 15 seconds (aggressive scalping)
  '30s': 30 * 1000,      // 30 seconds
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
} as const;

// API retry configuration
export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffMultiplier: 2,
};

// Trading constants
export const TRADING_CONSTANTS = {
  MIN_ORDER_SIZE: 0.001,
  MAX_LEVERAGE: 20, // Safe leverage for order book trading
  DEFAULT_SLIPPAGE: 0.001, // 0.1%
  ORDER_TIMEOUT: 30000, // 30 seconds
  ALLOWED_LEVERAGES: [20], // Use 20x leverage for safer trading
};

// AI constants
export const AI_CONSTANTS = {
  MAX_RETRIES: 3,
  TIMEOUT: 30000, // 30 seconds
  MIN_CONFIDENCE: 0.5,
  MAX_CONFIDENCE: 1.0,
};

// Technical indicator constants
export const INDICATOR_CONSTANTS = {
  RSI_OVERSOLD: 30,
  RSI_OVERBOUGHT: 70,
  MIN_CANDLES_FOR_INDICATORS: 100,
};

// Risk management constants
export const RISK_CONSTANTS = {
  MAX_POSITION_PERCENTAGE: 10, // 10% of account per position
  MIN_RISK_REWARD_RATIO: 1.5,
  MAX_CORRELATION: 0.7,
};

// Log file constants
export const LOG_CONSTANTS = {
  MAX_FILE_SIZE: '20m',
  MAX_FILES: '14d',
  DATE_PATTERN: 'YYYY-MM-DD',
};

// Market condition types
export const MARKET_CONDITIONS = {
  BULLISH: 'bullish',
  BEARISH: 'bearish',
  RANGING: 'ranging',
  VOLATILE: 'volatile',
  STABLE: 'stable',
} as const;

// Order status constants
export const ORDER_STATUS = {
  PENDING: 'pending',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
} as const;

// Error codes
export const ERROR_CODES = {
  INVALID_CONFIG: 'INVALID_CONFIG',
  API_ERROR: 'API_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  ORDER_REJECTED: 'ORDER_REJECTED',
  AI_ERROR: 'AI_ERROR',
  INDICATOR_ERROR: 'INDICATOR_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
} as const;

// Decision thresholds
export const DECISION_THRESHOLDS = {
  STRONG_BUY: 0.85,
  BUY: 0.7,
  HOLD: 0.5,
  SELL: 0.7,
  STRONG_SELL: 0.85,
} as const;

// File paths
export const FILE_PATHS = {
  AI_DECISIONS: 'logs/ai-decisions.json',
  TRADE_HISTORY: 'logs/trade-history.json',
  BACKTEST_RESULTS: 'logs/backtest-results.json',
} as const;

// API endpoints (Hyperliquid)
export const HYPERLIQUID_ENDPOINTS = {
  INFO: '/info',
  EXCHANGE: '/exchange',
} as const;

// Default values
export const DEFAULTS = {
  INITIAL_BALANCE: 10000,
  CANDLE_LIMIT: 100,
  POSITION_SIZE: 0.01,
  CONFIDENCE_THRESHOLD: 0.7,
} as const;
