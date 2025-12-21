import { logger } from '../core/logger';
import hyperliquidService from './hyperliquidService';

/**
 * Order Book Analysis Result
 */
export interface OrderBookAnalysis {
  symbol: string;
  timestamp: number;
  
  // Basic metrics
  bidVolume: number;      // Total volume on bid side
  askVolume: number;      // Total volume on ask side
  spread: number;         // Bid-ask spread in %
  spreadAbsolute: number; // Absolute spread
  midPrice: number;       // (bestBid + bestAsk) / 2
  
  // Imbalance metrics
  imbalanceRatio: number; // (bid - ask) / (bid + ask), range [-1, 1]
  imbalanceSignal: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  
  // Pressure analysis
  bidPressure: number;    // Weighted bid pressure (closer orders = more weight)
  askPressure: number;    // Weighted ask pressure
  pressureDelta: number;  // bidPressure - askPressure
  
  // Wall detection
  bidWalls: PriceWall[];  // Large buy orders
  askWalls: PriceWall[];  // Large sell orders
  nearestBidWall: PriceWall | null;
  nearestAskWall: PriceWall | null;
  
  // Liquidity
  liquidityScore: number; // 0-100, higher = more liquid
  
  // Trading signal
  orderBookSignal: number; // -1 to 1, positive = bullish
  confidence: number;      // 0-1, how confident in the signal
}

export interface PriceWall {
  price: number;
  size: number;
  distancePercent: number; // Distance from mid price in %
  isSignificant: boolean;  // > 2x average order size
}

interface OrderBookLevel {
  price: number;
  size: number;
}

/**
 * Order Book Analyzer - Analyzes order book for trading signals
 */
class OrderBookAnalyzer {
  // Configuration
  private readonly WALL_THRESHOLD_MULTIPLIER = 2.0; // Orders > 2x avg are "walls"
  private readonly IMBALANCE_STRONG_THRESHOLD = 0.4;
  private readonly IMBALANCE_WEAK_THRESHOLD = 0.15;
  private readonly MAX_DEPTH_LEVELS = 20; // Analyze top 20 levels
  
  // Cache for momentum tracking
  private previousImbalance: Map<string, number[]> = new Map();
  private readonly MOMENTUM_WINDOW = 5; // Track last 5 readings

  /**
   * Fetch and analyze order book for a symbol
   */
  async analyzeOrderBook(symbol: string): Promise<OrderBookAnalysis | null> {
    try {
      const orderBook = await hyperliquidService.getOrderBook(symbol, this.MAX_DEPTH_LEVELS);
      
      if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
        logger.warn(`Empty order book for ${symbol}`);
        return null;
      }

      const analysis = this.processOrderBook(symbol, orderBook.bids, orderBook.asks);
      
      // Track imbalance history for momentum
      this.updateImbalanceHistory(symbol, analysis.imbalanceRatio);
      
      return analysis;
    } catch (error) {
      logger.error(`Failed to analyze order book for ${symbol}`, error);
      return null;
    }
  }

  /**
   * Process raw order book data into analysis
   */
  private processOrderBook(
    symbol: string,
    bids: OrderBookLevel[],
    asks: OrderBookLevel[]
  ): OrderBookAnalysis {
    const timestamp = Date.now();
    
    // Best bid/ask
    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadAbsolute = bestAsk - bestBid;
    const spread = midPrice > 0 ? (spreadAbsolute / midPrice) * 100 : 0;

    // Calculate volumes
    const bidVolume = bids.reduce((sum, level) => sum + level.size, 0);
    const askVolume = asks.reduce((sum, level) => sum + level.size, 0);
    const totalVolume = bidVolume + askVolume;

    // Imbalance ratio: positive = more bids (bullish), negative = more asks (bearish)
    const imbalanceRatio = totalVolume > 0 
      ? (bidVolume - askVolume) / totalVolume 
      : 0;

    // Classify imbalance signal
    const imbalanceSignal = this.classifyImbalance(imbalanceRatio);

    // Calculate weighted pressure (orders closer to mid price have more impact)
    const { bidPressure, askPressure } = this.calculateWeightedPressure(
      bids, asks, midPrice
    );
    const pressureDelta = bidPressure - askPressure;

    // Detect walls
    const avgBidSize = bidVolume / bids.length;
    const avgAskSize = askVolume / asks.length;
    
    const bidWalls = this.detectWalls(bids, avgBidSize, midPrice);
    const askWalls = this.detectWalls(asks, avgAskSize, midPrice);

    // Find nearest significant walls
    const nearestBidWall = bidWalls.find(w => w.isSignificant) || null;
    const nearestAskWall = askWalls.find(w => w.isSignificant) || null;

    // Calculate liquidity score (0-100)
    const liquidityScore = this.calculateLiquidityScore(
      totalVolume, spread, bids.length, asks.length
    );

    // Generate trading signal (-1 to 1)
    const { signal: orderBookSignal, confidence } = this.generateSignal(
      imbalanceRatio,
      pressureDelta,
      spread,
      liquidityScore,
      bidWalls,
      askWalls
    );

    return {
      symbol,
      timestamp,
      bidVolume,
      askVolume,
      spread,
      spreadAbsolute,
      midPrice,
      imbalanceRatio,
      imbalanceSignal,
      bidPressure,
      askPressure,
      pressureDelta,
      bidWalls,
      askWalls,
      nearestBidWall,
      nearestAskWall,
      liquidityScore,
      orderBookSignal,
      confidence,
    };
  }

  /**
   * Classify imbalance into signal
   */
  private classifyImbalance(ratio: number): OrderBookAnalysis['imbalanceSignal'] {
    if (ratio >= this.IMBALANCE_STRONG_THRESHOLD) return 'STRONG_BUY';
    if (ratio >= this.IMBALANCE_WEAK_THRESHOLD) return 'BUY';
    if (ratio <= -this.IMBALANCE_STRONG_THRESHOLD) return 'STRONG_SELL';
    if (ratio <= -this.IMBALANCE_WEAK_THRESHOLD) return 'SELL';
    return 'NEUTRAL';
  }

  /**
   * Calculate weighted pressure (closer to mid = higher weight)
   */
  private calculateWeightedPressure(
    bids: OrderBookLevel[],
    asks: OrderBookLevel[],
    midPrice: number
  ): { bidPressure: number; askPressure: number } {
    let bidPressure = 0;
    let askPressure = 0;

    for (const bid of bids) {
      const distance = Math.abs(bid.price - midPrice) / midPrice;
      const weight = Math.exp(-distance * 100); // Exponential decay
      bidPressure += bid.size * weight;
    }

    for (const ask of asks) {
      const distance = Math.abs(ask.price - midPrice) / midPrice;
      const weight = Math.exp(-distance * 100);
      askPressure += ask.size * weight;
    }

    // Normalize
    const total = bidPressure + askPressure;
    if (total > 0) {
      bidPressure = bidPressure / total;
      askPressure = askPressure / total;
    }

    return { bidPressure, askPressure };
  }

  /**
   * Detect large orders (walls)
   */
  private detectWalls(
    levels: OrderBookLevel[],
    avgSize: number,
    midPrice: number
  ): PriceWall[] {
    return levels.map(level => {
      const distancePercent = Math.abs(level.price - midPrice) / midPrice * 100;
      const isSignificant = level.size > avgSize * this.WALL_THRESHOLD_MULTIPLIER;
      
      return {
        price: level.price,
        size: level.size,
        distancePercent,
        isSignificant,
      };
    }).filter(wall => wall.isSignificant);
  }

  /**
   * Calculate liquidity score (0-100)
   */
  private calculateLiquidityScore(
    totalVolume: number,
    spread: number,
    bidLevels: number,
    askLevels: number
  ): number {
    // Higher volume = better
    // Lower spread = better
    // More levels = better
    
    const volumeScore = Math.min(totalVolume / 100, 1) * 40; // Max 40 points
    const spreadScore = Math.max(0, 1 - spread * 10) * 30;   // Max 30 points (lower spread = better)
    const depthScore = Math.min((bidLevels + askLevels) / 40, 1) * 30; // Max 30 points
    
    return Math.round(volumeScore + spreadScore + depthScore);
  }

  /**
   * Generate trading signal from order book analysis
   */
  private generateSignal(
    imbalanceRatio: number,
    pressureDelta: number,
    spread: number,
    liquidityScore: number,
    bidWalls: PriceWall[],
    askWalls: PriceWall[]
  ): { signal: number; confidence: number } {
    // Base signal from imbalance (weight: 40%)
    let signal = imbalanceRatio * 0.4;
    
    // Add pressure delta (weight: 30%)
    signal += pressureDelta * 0.3;
    
    // Wall analysis (weight: 20%)
    // If there's a big bid wall nearby = support = bullish
    // If there's a big ask wall nearby = resistance = bearish
    const nearBidWall = bidWalls.find(w => w.distancePercent < 0.5);
    const nearAskWall = askWalls.find(w => w.distancePercent < 0.5);
    
    if (nearBidWall && !nearAskWall) signal += 0.1;
    else if (nearAskWall && !nearBidWall) signal -= 0.1;
    
    // Momentum from imbalance history (weight: 10%)
    // Implemented via updateImbalanceHistory
    
    // Clamp signal to [-1, 1]
    signal = Math.max(-1, Math.min(1, signal));
    
    // Calculate confidence based on liquidity and spread
    let confidence = liquidityScore / 100;
    
    // Reduce confidence if spread is too high
    if (spread > 0.1) confidence *= 0.7;
    if (spread > 0.2) confidence *= 0.5;
    
    // Reduce confidence if signal is weak
    if (Math.abs(signal) < 0.1) confidence *= 0.5;
    
    return { signal, confidence };
  }

  /**
   * Track imbalance history for momentum analysis
   */
  private updateImbalanceHistory(symbol: string, imbalance: number): void {
    if (!this.previousImbalance.has(symbol)) {
      this.previousImbalance.set(symbol, []);
    }
    
    const history = this.previousImbalance.get(symbol)!;
    history.push(imbalance);
    
    // Keep only last N readings
    if (history.length > this.MOMENTUM_WINDOW) {
      history.shift();
    }
  }

  /**
   * Get imbalance momentum (positive = improving, negative = deteriorating)
   */
  getImbalanceMomentum(symbol: string): number {
    const history = this.previousImbalance.get(symbol);
    if (!history || history.length < 2) return 0;
    
    // Compare recent to older readings
    const recent = history.slice(-2).reduce((a, b) => a + b, 0) / 2;
    const older = history.slice(0, -2).reduce((a, b) => a + b, 0) / Math.max(history.length - 2, 1);
    
    return recent - older;
  }

  /**
   * Format analysis for AI prompt
   */
  formatForAI(analysis: OrderBookAnalysis): string {
    return `Order Book Analysis for ${analysis.symbol}:
- Bid/Ask Imbalance: ${(analysis.imbalanceRatio * 100).toFixed(1)}% (${analysis.imbalanceSignal})
- Spread: ${analysis.spread.toFixed(4)}%
- Liquidity Score: ${analysis.liquidityScore}/100
- Bid Pressure: ${(analysis.bidPressure * 100).toFixed(1)}%
- Ask Pressure: ${(analysis.askPressure * 100).toFixed(1)}%
- Pressure Delta: ${(analysis.pressureDelta * 100).toFixed(1)}%
- Order Book Signal: ${analysis.orderBookSignal.toFixed(3)} (${analysis.orderBookSignal > 0.2 ? 'BULLISH' : analysis.orderBookSignal < -0.2 ? 'BEARISH' : 'NEUTRAL'})
- Signal Confidence: ${(analysis.confidence * 100).toFixed(0)}%
${analysis.nearestBidWall ? `- Nearest Bid Wall: $${analysis.nearestBidWall.price.toFixed(2)} (${analysis.nearestBidWall.size.toFixed(2)} @ ${analysis.nearestBidWall.distancePercent.toFixed(2)}% below)` : ''}
${analysis.nearestAskWall ? `- Nearest Ask Wall: $${analysis.nearestAskWall.price.toFixed(2)} (${analysis.nearestAskWall.size.toFixed(2)} @ ${analysis.nearestAskWall.distancePercent.toFixed(2)}% above)` : ''}`;
  }
}

export const orderBookAnalyzer = new OrderBookAnalyzer();
export default orderBookAnalyzer;
