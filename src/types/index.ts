/**
 * Type definitions for Trading AI Agent
 */

// Market Data Types
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Market {
  symbol: string;
  name: string;
  baseAsset: string;
  quoteAsset: string;
  minOrderSize: number;
  maxOrderSize: number;
  tickSize: number;
  status: 'active' | 'inactive';
}

// Account Types
export interface Account {
  balance: number;
  availableBalance: number;
  positions: Position[];
  totalPnL: number;
  dailyPnL: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  leverage: number;
}

// Order Types
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'pending' | 'filled' | 'partial' | 'cancelled' | 'rejected';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface OrderResponse {
  orderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  status: OrderStatus;
  filledQuantity: number;
  timestamp: number;
  fee: number;
}

// Technical Indicators Types
export interface Indicators {
  rsi: number;
  macd: MACDResult;
  ema12: number;
  ema26: number;
  bollingerBands: BollingerBandsResult;
  sma20: number;
  atr: number;
  volumeAverage: number;
}

// Multi-timeframe Indicators for AI analysis
export interface MultiTimeframeIndicators {
  // RSI at different periods
  rsi: {
    short: number;    // RSI-7 (scalping, very reactive)
    medium: number;   // RSI-14 (standard)
    long: number;     // RSI-21 (trend confirmation)
  };
  
  // EMA pairs at different timeframes
  ema: {
    scalping: { fast: number; slow: number; trend: 'bullish' | 'bearish' | 'neutral' };  // 5/13
    standard: { fast: number; slow: number; trend: 'bullish' | 'bearish' | 'neutral' };  // 12/26
    swing: { fast: number; slow: number; trend: 'bullish' | 'bearish' | 'neutral' };     // 20/50
  };
  
  // MACD at different settings
  macd: {
    fast: MACDResult;    // 5/13/5 (scalping)
    standard: MACDResult; // 12/26/9 (traditional)
  };
  
  // Bollinger Bands at different settings
  bollingerBands: {
    tight: BollingerBandsResult;   // 10 period, 1.5 stdDev (scalping)
    standard: BollingerBandsResult; // 20 period, 2 stdDev (traditional)
  };
  
  // ATR for volatility
  atr: {
    short: number;  // ATR-7
    medium: number; // ATR-14
  };
  
  // Volume analysis
  volume: {
    current: number;
    average20: number;
    average50: number;
    ratio: number;
    isHigh: boolean;
  };
  
  // SMA levels
  sma: {
    sma10: number;
    sma20: number;
    sma50: number;
  };
  
  // Aggregated signals
  signals: {
    rsiOversold: boolean;
    rsiOverbought: boolean;
    macdBullish: boolean;
    macdBearish: boolean;
    priceAboveEMA: boolean;
    priceBelowEMA: boolean;
    highVolume: boolean;
    nearBBUpper: boolean;
    nearBBLower: boolean;
  };
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
}

// AI Decision Types
export type AIDecision = 'BUY' | 'SELL' | 'HOLD';

export interface AIResponse {
  decision: AIDecision;
  confidence: number; // 0-1
  reasoning: string;
  suggestedPrice?: number;
  suggestedQuantity?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface AIPromptContext {
  symbol: string;
  currentPrice: number;
  indicators: Indicators;
  multiTfIndicators?: MultiTimeframeIndicators; // NEW: Multi-timeframe indicators
  recentCandles: Candle[];
  accountBalance: number;
  currentPosition?: Position;
  marketCondition: string;
  timestamp: number;
  openPositions?: any[];
  hasOpenPosition?: boolean;
  existingPosition?: any;
  unrealizedPnl?: number;
  unrealizedPnlPercentage?: number;
  // Order book analysis
  orderBookAnalysis?: {
    imbalanceRatio: number;
    imbalanceSignal: string;
    spread: number;
    liquidityScore: number;
    orderBookSignal: number;
    confidence: number;
    bidPressure: number;
    askPressure: number;
    nearestBidWall?: { price: number; size: number; distancePercent: number };
    nearestAskWall?: { price: number; size: number; distancePercent: number };
  };
  // Trading statistics for AI decision making
  tradeStats?: {
    totalTrades: number;
    winRate: number;
    recentWinRate: number;
    profitFactor: number;
    consecutiveLosses: number;
    averageWin: number;
    averageLoss: number;
  };
  // Additional context for hybrid mode
  additionalContext?: string;
}

// Trade Execution Types
export interface TradeDecision {
  timestamp: number;
  symbol: string;
  decision: AIDecision;
  confidence: number;
  reasoning: string;
  currentPrice: number;
  indicators: Indicators;
  executed: boolean;
  orderId?: string;
  error?: string;
}

export interface TradeResult {
  success: boolean;
  order?: OrderResponse;
  error?: string;
  decision?: TradeDecision;
}

// Backtest Types
export interface BacktestConfig {
  symbol: string;
  startDate: string;
  endDate: string;
  initialBalance: number;
  positionSize: number;
  confidenceThreshold: number;
}

export interface BacktestResult {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  roi: number;
  maxDrawdown: number;
  averageProfitPerTrade: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
}

export interface BacktestTrade {
  timestamp: number;
  symbol: string;
  side: OrderSide;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  confidence: number;
  reasoning: string;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  drawdown: number;
}

// Configuration Types
export interface Config {
  hyperliquid: HyperliquidConfig;
  ai: AIConfig;
  trading: TradingConfig;
  risk: RiskConfig;
  system: SystemConfig;
  indicators: IndicatorConfig;
}

export interface HyperliquidConfig {
  apiKey: string;
  secret: string;
  apiUrl: string;
  walletAddress: string;
}

export interface AIConfig {
  provider: 'openai' | 'deepseek' | 'anthropic';
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TradingConfig {
  baseSymbol: string; // Deprecated - usa symbols
  symbols: string[]; // Array di coppie trading (es: ['BTC-USDC', 'ETH-USDC'])
  tradeInterval: string;
  positionSize: number; // Deprecated - usa startingBalance + positionSizePercentage
  maxPositionSize: number; // Deprecated
  confidenceThreshold: number;
  startingBalance: number; // Capital iniziale (es: 100$)
  positionSizePercentage: number; // % capital per trade (es: 10)
  maxPositions: number; // Max posizioni contemporanee (es: 5)
  minLeverage: number; // Leva minima (es: 2x)
  maxLeverage: number; // Leva massima (es: 10x)
}

export interface RiskConfig {
  stopLossPercentage: number;
  takeProfitPercentage: number;
  maxDailyTrades: number;
  maxDailyLoss: number;
}

export interface SystemConfig {
  logLevel: string;
  logDir: string;
  enableLiveTrading: boolean;
  dryRun: boolean;
  enableScheduler: boolean;
  tradingStartHour: number;
  tradingEndHour: number;
}

export interface IndicatorConfig {
  rsiPeriod: number;
  emaFast: number;
  emaSlow: number;
  macdSignal: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
}

// Logger Types
export interface LogMetadata {
  tradeId?: string;
  symbol?: string;
  decision?: AIDecision;
  confidence?: number;
  price?: number;
  balance?: number;
  pnl?: number;
  orderId?: string;
  error?: string;
  [key: string]: string | number | boolean | undefined;
}

// Scheduler Types
export interface ScheduleConfig {
  interval: string;
  enabled: boolean;
  startHour: number;
  endHour: number;
}

// Error Types
export class TradingError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TradingError';
  }
}

export class HyperliquidError extends TradingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'HYPERLIQUID_ERROR', details);
    this.name = 'HyperliquidError';
  }
}

export class AIError extends TradingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AI_ERROR', details);
    this.name = 'AIError';
  }
}

export class ValidationError extends TradingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}
