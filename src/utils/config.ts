import dotenv from 'dotenv';
import { Config, ValidationError } from '../types';

// Load environment variables
dotenv.config();

/**
 * Validates that a required environment variable exists
 * @param key - Environment variable name
 * @param defaultValue - Optional default value
 * @returns The environment variable value
 */
function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new ValidationError(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Validates and loads configuration from environment variables
 */
export const config: Config = {
  hyperliquid: {
    apiKey: '', // Not needed for Hyperliquid (uses wallet signature instead)
    secret: getEnvVar('HYPERLIQUID_SECRET'),
    apiUrl: getEnvVar('HYPERLIQUID_API_URL', 'https://api.hyperliquid-testnet.xyz'),
    walletAddress: getEnvVar('HYPERLIQUID_WALLET_ADDRESS'),
  },
  ai: {
    provider: (getEnvVar('AI_PROVIDER', 'openai') as 'openai' | 'deepseek' | 'anthropic'),
    model: getEnvVar('AI_MODEL', 'gpt-4-turbo-preview'),
    apiKey:
      process.env.AI_PROVIDER === 'anthropic'
        ? getEnvVar('ANTHROPIC_API_KEY')
        : process.env.AI_PROVIDER === 'deepseek'
          ? getEnvVar('DEEPSEEK_API_KEY')
          : getEnvVar('OPENAI_API_KEY'),
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '1000', 10),
    temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
  },
  trading: {
    baseSymbol: getEnvVar('BASE_SYMBOL', 'BTC-USD'), // Per compatibilità
    symbols: getEnvVar('TRADING_SYMBOLS', 'BTC-USDC,ETH-USDC,SOL-USDC,XRP-USDC,DOGE-USDC').split(',').map(s => s.trim()),
    tradeInterval: getEnvVar('TRADE_INTERVAL', '15s'), // 15 seconds for aggressive sub-minute scalping
    positionSize: parseFloat(getEnvVar('POSITION_SIZE', '0.01')), // Deprecated
    maxPositionSize: parseFloat(getEnvVar('MAX_POSITION_SIZE', '0.1')), // Deprecated
    confidenceThreshold: parseFloat(getEnvVar('CONFIDENCE_THRESHOLD', '0.7')),
    startingBalance: parseFloat(getEnvVar('STARTING_BALANCE', '100')),
    positionSizePercentage: parseFloat(getEnvVar('POSITION_SIZE_PERCENTAGE', '50')),
    positionSizeMultiplier: parseFloat(getEnvVar('POSITION_SIZE_MULTIPLIER', '10')),
    maxPositions: parseInt(getEnvVar('MAX_POSITIONS', '5'), 10),
    minLeverage: parseFloat(getEnvVar('MIN_LEVERAGE', '2')),
    maxLeverage: parseFloat(getEnvVar('MAX_LEVERAGE', '5')), // REDUCED: 5x is safer
  },
  regime: {
    symbols: getEnvVar('SYMBOLS', 'BTC-USDC,ETH-USDC').split(',').map(s => s.trim()),
    leverage: parseFloat(getEnvVar('LEVERAGE', '8')),
    maxExecutionSlippageBps: parseFloat(getEnvVar('MAX_EXECUTION_SLIPPAGE_BPS', '8')),
    executionTicks: parseInt(getEnvVar('EXECUTION_TICKS', '1'), 10),
    dataStaleMs: parseInt(getEnvVar('DATA_STALE_MS', '5000'), 10),
    compressionRatio: parseFloat(getEnvVar('COMPRESSION_RATIO', '0.6')),
    volumeSpikeMult: parseFloat(getEnvVar('VOLUME_SPIKE_MULT', '2.0')),
    rangeWindowMinutes: parseInt(getEnvVar('RANGE_WINDOW_MINUTES', '15'), 10),
    volShortMinutes: parseInt(getEnvVar('VOL_SHORT_MINUTES', '5'), 10),
    volLongMinutes: parseInt(getEnvVar('VOL_LONG_MINUTES', '30'), 10),
    minNetEdgeBps: parseFloat(getEnvVar('MIN_NET_EDGE_BPS', '12')),
    spreadBpsEst: parseFloat(getEnvVar('SPREAD_BPS_EST', '2')),
    slippageBpsEst: parseFloat(getEnvVar('SLIPPAGE_BPS_EST', '4')),
    takerFeeBps: parseFloat(getEnvVar('TAKER_FEE_BPS', '6')),
    riskPerTradePct: parseFloat(getEnvVar('RISK_PER_TRADE_PCT', '0.3')),
    stopAtrMult: parseFloat(getEnvVar('STOP_ATR_MULT', '0.35')),
    tpRMult: parseFloat(getEnvVar('TP_R_MULT', '2.5')),
    timeStopSeconds: parseInt(getEnvVar('TIME_STOP_SECONDS', '240'), 10),
    maxHoldSeconds: parseInt(getEnvVar('MAX_HOLD_SECONDS', '900'), 10),
    minProgressBps: parseFloat(getEnvVar('MIN_PROGRESS_BPS', '1')), // minimum favorable move (bps) within time-stop window
    maxTradesPerDay: parseInt(getEnvVar('MAX_TRADES_PER_DAY', '2'), 10),
    cooldownSeconds: parseInt(getEnvVar('COOLDOWN_SECONDS', '600'), 10),
    maxDailyDrawdownPct: parseFloat(getEnvVar('MAX_DAILY_DRAWDOWN_PCT', '2.5')),
    maxConsecutiveLosses: parseInt(getEnvVar('MAX_CONSECUTIVE_LOSSES', '3'), 10),
    fundingFilter: parseFloat(getEnvVar('FUNDING_FILTER', '0')),
    dryRun: getEnvVar('DRY_RUN', 'true') === 'true',
    // ========== MAKER-FIRST EXECUTION ==========
    regimeEvalIntervalMs: parseInt(getEnvVar('REGIME_EVAL_INTERVAL_MS', '3000'), 10),
    makerFeeBps: parseFloat(getEnvVar('MAKER_FEE_BPS', '-1')), // rebate = negative
    spreadBpsEstMax: parseFloat(getEnvVar('SPREAD_BPS_EST_MAX', '5')),
    makerFirst: getEnvVar('MAKER_FIRST', 'true') === 'true',
    makerPostOnly: getEnvVar('MAKER_POST_ONLY', 'true') === 'true',
    quoteTickOffset: parseInt(getEnvVar('QUOTE_TICK_OFFSET', '1'), 10),
    maxQueueWaitMs: parseInt(getEnvVar('MAX_QUEUE_WAIT_MS', '350'), 10),
    maxRequotePerSec: parseFloat(getEnvVar('MAX_REQUOTE_PER_SEC', '2')),
    allowTakerFallback: getEnvVar('ALLOW_TAKER_FALLBACK', 'true') === 'true',
    takerOnlyIfNetEdgeBps: parseFloat(getEnvVar('TAKER_ONLY_IF_NET_EDGE_BPS', '20')),
    regimeSignalCacheTtlMs: parseInt(getEnvVar('REGIME_SIGNAL_CACHE_TTL_MS', '5000'), 10),
  },
  risk: {
    stopLossPercentage: parseFloat(getEnvVar('STOP_LOSS_PERCENTAGE', '2')),
    takeProfitPercentage: parseFloat(getEnvVar('TAKE_PROFIT_PERCENTAGE', '5')),
    maxDailyTrades: parseInt(getEnvVar('MAX_DAILY_TRADES', '999999'), 10),
    maxDailyLoss: parseFloat(getEnvVar('MAX_DAILY_LOSS', '100')),
  },
  system: {
    logLevel: getEnvVar('LOG_LEVEL', 'info'),
    logDir: getEnvVar('LOG_DIR', './logs'),
    enableLiveTrading: getEnvVar('ENABLE_LIVE_TRADING', 'false') === 'true',
    dryRun: getEnvVar('DRY_RUN', 'true') === 'true',
    enableScheduler: getEnvVar('ENABLE_SCHEDULER', 'true') === 'true',
    tradingStartHour: parseInt(getEnvVar('TRADING_START_HOUR', '0'), 10),
    tradingEndHour: parseInt(getEnvVar('TRADING_END_HOUR', '23'), 10),
  },
  indicators: {
    rsiPeriod: parseInt(getEnvVar('RSI_PERIOD', '14'), 10),
    emaFast: parseInt(getEnvVar('EMA_FAST', '12'), 10),
    emaSlow: parseInt(getEnvVar('EMA_SLOW', '26'), 10),
    macdSignal: parseInt(getEnvVar('MACD_SIGNAL', '9'), 10),
    bollingerPeriod: parseInt(getEnvVar('BOLLINGER_PERIOD', '20'), 10),
    bollingerStdDev: parseFloat(getEnvVar('BOLLINGER_STD_DEV', '2')),
  },
  // WebSocket / HTTP fallback market data configuration
  marketData: {
    useWsMarketData: getEnvVar('USE_WS_MARKET_DATA', 'true') === 'true',
    wsUrl: getEnvVar('HYPERLIQUID_WS_URL', 'wss://api.hyperliquid.xyz/ws'),
    wsStaleMs: parseInt(getEnvVar('WS_STALE_MS', '5000'), 10),
    wsReconnectMaxDelayMs: parseInt(getEnvVar('WS_RECONNECT_MAX_DELAY_MS', '30000'), 10),
    httpFallbackMinIntervalMs: parseInt(getEnvVar('HTTP_FALLBACK_MIN_INTERVAL_MS', '5000'), 10),
    fallbackCheckIntervalMs: parseInt(getEnvVar('FALLBACK_CHECK_INTERVAL_MS', '30000'), 10),
    orderBookDepth: parseInt(getEnvVar('ORDER_BOOK_DEPTH', '100'), 10),
  },
};

/**
 * Validates the configuration
 */
export function validateConfig(): void {
  // Validate AI provider
  if (!['openai', 'deepseek', 'anthropic'].includes(config.ai.provider)) {
    throw new ValidationError('AI_PROVIDER must be either "openai", "deepseek", or "anthropic"');
  }

  // Validate trading parameters
  if (config.trading.positionSize <= 0) {
    throw new ValidationError('POSITION_SIZE must be greater than 0');
  }

  if (config.trading.confidenceThreshold < 0 || config.trading.confidenceThreshold > 1) {
    throw new ValidationError('CONFIDENCE_THRESHOLD must be between 0 and 1');
  }

  // Validate risk parameters
  if (config.risk.stopLossPercentage <= 0 || config.risk.stopLossPercentage > 100) {
    throw new ValidationError('STOP_LOSS_PERCENTAGE must be between 0 and 100');
  }

  // Validate system parameters
  if (config.system.tradingStartHour < 0 || config.system.tradingStartHour > 23) {
    throw new ValidationError('TRADING_START_HOUR must be between 0 and 23');
  }

  if (config.system.tradingEndHour < 0 || config.system.tradingEndHour > 23) {
    throw new ValidationError('TRADING_END_HOUR must be between 0 and 23');
  }

  // Validate live trading safety
  if (config.system.enableLiveTrading && config.system.dryRun) {
    console.warn('WARNING: Live trading is enabled but DRY_RUN is also true. Orders will be simulated.');
  }

  if (config.system.enableLiveTrading && !config.system.dryRun) {
    console.warn('⚠️  LIVE TRADING IS ENABLED - REAL MONEY WILL BE AT RISK ⚠️');
  }
}

// Validate configuration on load
validateConfig();

export default config;
