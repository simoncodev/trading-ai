import { logger } from '../core/logger';
import hyperliquidService from './hyperliquidService';

/**
 * Market Regime Types
 */
export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY';

/**
 * Adaptive Trading Parameters
 */
export interface AdaptiveParams {
  // Order Book Strategy
  strongImbalanceThreshold: number;
  weakImbalanceThreshold: number;
  maxSpreadPercent: number;
  minLiquidityScore: number;
  pressureThreshold: number;
  minTradeConfidence: number;
  
  // Risk Management
  stopLossPercent: number;
  takeProfitPercent: number;
  
  // Position Sizing
  positionSizeMultiplier: number;
  
  // Metadata
  regime: MarketRegime;
  volatility: number;
  trendStrength: number;
  lastUpdate: number;
}

/**
 * Default parameters (baseline)
 */
const DEFAULT_PARAMS: Omit<AdaptiveParams, 'regime' | 'volatility' | 'trendStrength' | 'lastUpdate'> = {
  strongImbalanceThreshold: 0.35,
  weakImbalanceThreshold: 0.22,
  maxSpreadPercent: 0.12,
  minLiquidityScore: 45,
  pressureThreshold: 0.58,
  minTradeConfidence: 0.55,
  stopLossPercent: 3,
  takeProfitPercent: 6,
  positionSizeMultiplier: 1.0,
};

/**
 * Regime-specific parameter adjustments
 */
const REGIME_ADJUSTMENTS: Record<MarketRegime, Partial<AdaptiveParams>> = {
  'TRENDING_UP': {
    // In uptrend: be more aggressive on BUY signals
    strongImbalanceThreshold: 0.30,  // Lower threshold for buys
    weakImbalanceThreshold: 0.18,
    minTradeConfidence: 0.50,
    takeProfitPercent: 8,  // Let winners run
    stopLossPercent: 2.5,  // Tighter SL
    positionSizeMultiplier: 1.2,
  },
  'TRENDING_DOWN': {
    // In downtrend: be more aggressive on SELL signals
    strongImbalanceThreshold: 0.30,
    weakImbalanceThreshold: 0.18,
    minTradeConfidence: 0.50,
    takeProfitPercent: 8,
    stopLossPercent: 2.5,
    positionSizeMultiplier: 1.2,
  },
  'RANGING': {
    // In range: be selective but not overly restrictive
    strongImbalanceThreshold: 0.48,  // Balanced threshold (55% was too strict, 40% too loose)
    weakImbalanceThreshold: 0.35,    // Reasonable minimum
    minTradeConfidence: 0.68,        // Decent confidence required (75% was too strict)
    takeProfitPercent: 3,            // Quick scalps
    stopLossPercent: 1.5,            // Tight SL to minimize losses
    positionSizeMultiplier: 0.6,     // Reduced size but not too much
  },
  'HIGH_VOLATILITY': {
    // High vol: be very selective, wider SL/TP
    strongImbalanceThreshold: 0.45,
    weakImbalanceThreshold: 0.32,
    maxSpreadPercent: 0.15,  // Accept wider spreads
    minLiquidityScore: 50,
    minTradeConfidence: 0.65,
    takeProfitPercent: 10,   // Wider TP
    stopLossPercent: 5,      // Wider SL
    positionSizeMultiplier: 0.5,  // Reduce size
  },
  'LOW_VOLATILITY': {
    // Low vol: more aggressive, tighter targets
    strongImbalanceThreshold: 0.28,
    weakImbalanceThreshold: 0.18,
    maxSpreadPercent: 0.08,  // Need tight spreads
    minTradeConfidence: 0.50,
    takeProfitPercent: 3,    // Quick scalps
    stopLossPercent: 1.5,    // Tight SL
    positionSizeMultiplier: 1.5,  // Can size up
  },
};

/**
 * Price history for volatility calculation
 */
interface PriceHistory {
  prices: number[];
  timestamps: number[];
  maxSize: number;
}

class AdaptiveParameterManager {
  private priceHistory: Map<string, PriceHistory> = new Map();
  private currentParams: Map<string, AdaptiveParams> = new Map();
  private updateInterval: number = 60000; // Update every 60 seconds
  
  constructor() {
    // Start background update loop
    this.startUpdateLoop();
  }

  /**
   * Get adaptive parameters for a symbol
   */
  async getParams(symbol: string): Promise<AdaptiveParams> {
    // Check if we have recent params
    const cached = this.currentParams.get(symbol);
    if (cached && Date.now() - cached.lastUpdate < this.updateInterval) {
      return cached;
    }

    // Calculate new params
    return await this.updateParams(symbol);
  }

  /**
   * Update parameters for a symbol
   */
  private async updateParams(symbol: string): Promise<AdaptiveParams> {
    try {
      // Get current price
      const currentPrice = await hyperliquidService.getTickerPrice(symbol);
      
      // Update price history
      this.addPriceToHistory(symbol, currentPrice);
      
      // Calculate metrics
      const volatility = this.calculateVolatility(symbol);
      const trendStrength = this.calculateTrendStrength(symbol);
      
      // Detect regime
      const regime = this.detectRegime(volatility, trendStrength);
      
      // Build adaptive params
      const regimeAdjustments = REGIME_ADJUSTMENTS[regime];
      const params: AdaptiveParams = {
        ...DEFAULT_PARAMS,
        ...regimeAdjustments,
        regime,
        volatility,
        trendStrength,
        lastUpdate: Date.now(),
      };
      
      // Cache params
      this.currentParams.set(symbol, params);
      
      logger.info(`📊 [${symbol}] Adaptive Params Updated`, {
        regime,
        volatility: `${(volatility * 100).toFixed(2)}%`,
        trendStrength: `${(trendStrength * 100).toFixed(0)}%`,
        confidence: params.minTradeConfidence,
        slTp: `${params.stopLossPercent}%/${params.takeProfitPercent}%`,
        sizeMultiplier: params.positionSizeMultiplier.toFixed(2),
      });
      
      return params;
    } catch (error) {
      logger.error(`Failed to update adaptive params for ${symbol}`, error);
      
      // Return default params on error
      return {
        ...DEFAULT_PARAMS,
        regime: 'RANGING',
        volatility: 0,
        trendStrength: 0,
        lastUpdate: Date.now(),
      };
    }
  }

  /**
   * Add price to history
   */
  private addPriceToHistory(symbol: string, price: number): void {
    let history = this.priceHistory.get(symbol);
    
    if (!history) {
      history = { prices: [], timestamps: [], maxSize: 100 };
      this.priceHistory.set(symbol, history);
    }
    
    history.prices.push(price);
    history.timestamps.push(Date.now());
    
    // Keep only last N prices
    if (history.prices.length > history.maxSize) {
      history.prices.shift();
      history.timestamps.shift();
    }
  }

  /**
   * Calculate volatility (standard deviation of returns)
   */
  private calculateVolatility(symbol: string): number {
    const history = this.priceHistory.get(symbol);
    
    if (!history || history.prices.length < 10) {
      return 0.02; // Default 2% if not enough data
    }
    
    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < history.prices.length; i++) {
      const ret = (history.prices[i] - history.prices[i - 1]) / history.prices[i - 1];
      returns.push(ret);
    }
    
    // Calculate standard deviation
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // Annualize (assuming ~1 minute intervals, ~525600 minutes/year)
    // But we scale down since we're looking at short-term
    return stdDev * Math.sqrt(60); // Hourly volatility
  }

  /**
   * Calculate trend strength (-1 to 1)
   * Positive = uptrend, Negative = downtrend, Near 0 = ranging
   */
  private calculateTrendStrength(symbol: string): number {
    const history = this.priceHistory.get(symbol);
    
    if (!history || history.prices.length < 20) {
      return 0;
    }
    
    const prices = history.prices;
    const n = prices.length;
    
    // Simple linear regression slope
    const xMean = (n - 1) / 2;
    const yMean = prices.reduce((a, b) => a + b, 0) / n;
    
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (prices[i] - yMean);
      denominator += Math.pow(i - xMean, 2);
    }
    
    const slope = numerator / denominator;
    
    // Normalize slope to -1 to 1 range based on price
    const normalizedSlope = (slope / yMean) * 100; // Percentage slope per period
    
    // Clamp to -1 to 1
    return Math.max(-1, Math.min(1, normalizedSlope * 10));
  }

  /**
   * Detect market regime
   */
  private detectRegime(volatility: number, trendStrength: number): MarketRegime {
    // High volatility threshold (varies by asset)
    const isHighVol = volatility > 0.03; // 3% hourly volatility
    const isLowVol = volatility < 0.008; // 0.8% hourly volatility
    
    // Trend thresholds
    const isStrongTrendUp = trendStrength > 0.3;
    const isStrongTrendDown = trendStrength < -0.3;
    
    if (isHighVol) {
      return 'HIGH_VOLATILITY';
    }
    
    if (isLowVol) {
      return 'LOW_VOLATILITY';
    }
    
    if (isStrongTrendUp) {
      return 'TRENDING_UP';
    }
    
    if (isStrongTrendDown) {
      return 'TRENDING_DOWN';
    }
    
    return 'RANGING';
  }

  /**
   * Start background update loop
   */
  private startUpdateLoop(): void {
    setInterval(async () => {
      // Update all tracked symbols
      const symbols = Array.from(this.priceHistory.keys());
      
      for (const symbol of symbols) {
        try {
          await this.updateParams(symbol);
        } catch (error) {
          // Ignore errors in background loop
        }
      }
    }, this.updateInterval);
  }

  /**
   * Get current regime for a symbol
   */
  getRegime(symbol: string): MarketRegime | null {
    const params = this.currentParams.get(symbol);
    return params?.regime || null;
  }

  /**
   * Get all current params (for dashboard display)
   */
  getAllParams(): Map<string, AdaptiveParams> {
    return this.currentParams;
  }

  /**
   * Force update for a symbol
   */
  async forceUpdate(symbol: string): Promise<AdaptiveParams> {
    return await this.updateParams(symbol);
  }
}

// Export singleton
export const adaptiveParams = new AdaptiveParameterManager();
export default adaptiveParams;
