import { logger } from '../core/logger';
import { orderBookAnalyzer, OrderBookAnalysis } from '../services/orderBookAnalyzer';
import { adaptiveParams } from '../services/adaptiveParameters';

/**
 * Order Book Trading Strategy - Pure order book based trading
 * Now with ADAPTIVE PARAMETERS based on market regime
 */

export interface OrderBookSignal {
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  orderBookData: OrderBookAnalysis;
  regime?: string;  // Market regime used
}

// Static config (non-adaptive)
const STATIC_CONFIG = {
  // Wall detection
  WALL_DISTANCE_THRESHOLD: 0.20,     // Wall within 0.20% = significant

  // Confidence boosts
  WALL_CONFIDENCE_BOOST: 0.10,       // +10% confidence if wall supports trade
  PRESSURE_CONFIDENCE_BOOST: 0.08,   // +8% confidence if pressure aligns
  MOMENTUM_CONFIDENCE_BOOST: 0.07,   // +7% confidence if momentum aligns
};
// Fallback config (used if adaptive params not available)
// OPTIMIZED: Higher confidence threshold
const FALLBACK_CONFIG = {
  STRONG_IMBALANCE_THRESHOLD: 0.35,
  WEAK_IMBALANCE_THRESHOLD: 0.22,
  MAX_SPREAD_PERCENT: 0.12,
  MIN_LIQUIDITY_SCORE: 45,
  PRESSURE_THRESHOLD: 0.58,
  MIN_TRADE_CONFIDENCE: 0.70,  // Raised from 0.55 to avoid marginal trades
};


/**
 * Get effective config (adaptive or fallback)
 */
async function getEffectiveConfig(symbol: string): Promise<{
  strongImbalance: number;
  weakImbalance: number;
  maxSpread: number;
  minLiquidity: number;
  pressureThreshold: number;
  minConfidence: number;
  regime: string;
}> {
  try {
    const params = await adaptiveParams.getParams(symbol);
    return {
      strongImbalance: params.strongImbalanceThreshold,
      weakImbalance: params.weakImbalanceThreshold,
      maxSpread: params.maxSpreadPercent,
      minLiquidity: params.minLiquidityScore,
      pressureThreshold: params.pressureThreshold,
      minConfidence: params.minTradeConfidence,
      regime: params.regime,
    };
  } catch {
    return {
      strongImbalance: FALLBACK_CONFIG.STRONG_IMBALANCE_THRESHOLD,
      weakImbalance: FALLBACK_CONFIG.WEAK_IMBALANCE_THRESHOLD,
      maxSpread: FALLBACK_CONFIG.MAX_SPREAD_PERCENT,
      minLiquidity: FALLBACK_CONFIG.MIN_LIQUIDITY_SCORE,
      pressureThreshold: FALLBACK_CONFIG.PRESSURE_THRESHOLD,
      minConfidence: FALLBACK_CONFIG.MIN_TRADE_CONFIDENCE,
      regime: 'UNKNOWN',
    };
  }
}

/**
 * Generate trading signal from order book data
 */
export async function generateOrderBookSignal(symbol: string): Promise<OrderBookSignal | null> {
  try {
    // Get adaptive parameters
    const config = await getEffectiveConfig(symbol);

    const analysis = await orderBookAnalyzer.analyzeOrderBook(symbol);

    if (!analysis) {
      logger.warn(`[OrderBookStrategy] No order book data for ${symbol}`);
      return null;
    }

    // Log order book data with regime and market state
    logger.info(`📊 [${symbol}] Order Book (${config.regime}) [${analysis.marketState}]:`, {
      imbalance: `${(analysis.imbalanceRatio * 100).toFixed(1)}%`,
      signal: analysis.imbalanceSignal,
      spread: `${analysis.spread.toFixed(4)}%`,
      bidPressure: `${(analysis.bidPressure * 100).toFixed(1)}%`,
      askPressure: `${(analysis.askPressure * 100).toFixed(1)}%`,
      liquidity: analysis.liquidityScore,
      marketState: analysis.marketState,
      aggression: `${(analysis.aggressionScore * 100).toFixed(0)}%`,
      breakoutConfirmed: analysis.breakoutConfirmed,
    });

    // ========================================
    // FABIO VALENTINO'S MARKET STATE FILTER
    // Key: "Trade only when market is out of balance"
    // ========================================

    // CONSOLIDATION: DO NOT TRADE
    if (analysis.marketState === 'CONSOLIDATION') {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `[CONSOLIDATION] Evitare trading - mercato bilanciato senza direzione`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // ABSORPTION DETECTED: Potential reversal - be cautious
    if (analysis.absorptionDetected) {
      logger.warn(`⚠️ [${symbol}] ABSORPTION DETECTED - Big orders no follow-through`);
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `[ABSORPTION] Grandi ordini senza follow-through - possibile inversione`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // Check basic requirements (using adaptive params)
    if (analysis.spread > config.maxSpread) {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `Spread troppo alto (${analysis.spread.toFixed(4)}% > ${config.maxSpread}%)`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    if (analysis.liquidityScore < config.minLiquidity) {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `Liquidità insufficiente (${analysis.liquidityScore} < ${config.minLiquidity})`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // Analyze imbalance
    const imbalance = analysis.imbalanceRatio;
    const absImbalance = Math.abs(imbalance);

    let decision: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let confidence = 0;
    let reasons: string[] = [];

    // Add market state and regime to reasoning
    reasons.push(`[${analysis.marketState}]`);
    reasons.push(`[${config.regime}]`);

    // ========================================
    // IMBALANCED MARKET - TREND FOLLOWING MODE
    // Key: "In uptrend only BUY, in downtrend only SELL"
    // ========================================
    if (analysis.marketState === 'IMBALANCED_UP' || analysis.marketState === 'IMBALANCED_DOWN') {
      const expectedDirection = analysis.marketState === 'IMBALANCED_UP' ? 'BUY' : 'SELL';

      // Strong signal: Market state + imbalance + aggression aligned
      if (absImbalance >= config.weakImbalance) {
        const imbalanceDirection = imbalance > 0 ? 'BUY' : 'SELL';

        // Only trade in direction of market state
        if (imbalanceDirection === expectedDirection) {
          decision = expectedDirection;
          // Base confidence higher in imbalanced market
          confidence = 0.55 + (absImbalance - config.weakImbalance) * 0.8;
          reasons.push(`📈 TREND MODE: ${expectedDirection} allineato con market state`);

          // Aggression bonus
          const aggressionAligns =
            (decision === 'BUY' && analysis.aggressionScore > 0.2) ||
            (decision === 'SELL' && analysis.aggressionScore < -0.2);

          if (aggressionAligns) {
            confidence += 0.12;
            reasons.push(`🔥 Aggression confirms: ${(analysis.aggressionScore * 100).toFixed(0)}%`);
          }

          // Breakout confirmation bonus (second drive)
          if (analysis.breakoutConfirmed) {
            confidence += 0.15;
            reasons.push(`✅ SECOND DRIVE CONFIRMED - alta probabilità`);
          }
        } else {
          reasons.push(`⚠️ Imbalance opposto a market state - SKIP`);
        }
      }
    }
    // ========================================
    // BALANCED MARKET - MEAN REVERSION / CAUTIOUS
    // Key: "Wait for second breakout confirmation"
    // ========================================
    else if (analysis.marketState === 'BALANCED') {
      // In balanced market, ONLY trade if breakout is confirmed
      if (!analysis.breakoutConfirmed) {
        // Check for strong imbalance that might indicate early breakout
        if (absImbalance >= config.strongImbalance) {
          reasons.push(`⏳ Imbalance forte ma attesa conferma second drive`);
          // Give a smaller signal for potential breakout
          const potentialDirection = imbalance > 0 ? 'BUY' : 'SELL';
          decision = potentialDirection;
          confidence = 0.45 + (absImbalance - config.strongImbalance) * 0.5;
          reasons.push(`Imbalance ${(imbalance * 100).toFixed(1)}% - confidence ridotta (no confirm)`);
        }
      } else {
        // Breakout confirmed in balanced market = good setup
        decision = imbalance > 0 ? 'BUY' : 'SELL';
        confidence = 0.60 + absImbalance * 0.4;
        reasons.push(`🎯 BREAKOUT CONFIRMED in balanced market`);
      }
    }

    // ========================================
    // ADDITIONAL CONFIDENCE MODIFIERS
    // ========================================
    if (decision !== 'HOLD') {
      // Wall support/resistance bonus
      if (decision === 'BUY' && analysis.nearestBidWall &&
        analysis.nearestBidWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
        confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
        reasons.push(`Wall supporto: $${analysis.nearestBidWall.price.toFixed(2)}`);
      }
      if (decision === 'SELL' && analysis.nearestAskWall &&
        analysis.nearestAskWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
        confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
        reasons.push(`Wall resistenza: $${analysis.nearestAskWall.price.toFixed(2)}`);
      }

      // Low Volume Node - high probability entry zone
      if (analysis.lowVolumeNode) {
        confidence += 0.08;
        reasons.push(`📍 LVN detected @ $${analysis.lowVolumeNode.price.toFixed(2)}`);
      }

      // Momentum check
      const momentum = orderBookAnalyzer.getImbalanceMomentum(symbol);
      const momentumAligns =
        (decision === 'BUY' && momentum > 0.05) ||
        (decision === 'SELL' && momentum < -0.05);

      const momentumOpposed =
        (decision === 'BUY' && momentum < -0.10) ||
        (decision === 'SELL' && momentum > 0.10);

      if (momentumOpposed) {
        confidence -= 0.15; // Stronger penalty
        reasons.push(`⚠️ Momentum contrario (${(momentum * 100).toFixed(1)}%)`);
      } else if (momentumAligns) {
        confidence += STATIC_CONFIG.MOMENTUM_CONFIDENCE_BOOST;
        reasons.push(`Momentum ${momentum > 0 ? '+' : ''}${(momentum * 100).toFixed(1)}%`);
      }

      // Pressure alignment
      const pressureAligns =
        (decision === 'BUY' && analysis.bidPressure > analysis.askPressure) ||
        (decision === 'SELL' && analysis.askPressure > analysis.bidPressure);

      if (pressureAligns) {
        confidence += STATIC_CONFIG.PRESSURE_CONFIDENCE_BOOST;
      }
    }

    // Cap confidence at 0.95
    confidence = Math.min(0.95, confidence);

    // Require minimum confidence to trade (adaptive)
    if (decision !== 'HOLD' && confidence < config.minConfidence) {
      reasons.push(`Confidence troppo bassa (${(confidence * 100).toFixed(0)}% < ${(config.minConfidence * 100).toFixed(0)}%)`);
      decision = 'HOLD';
    }

    const reasoning = reasons.join(' | ');

    logger.info(`📈 [${symbol}] Order Book Signal: ${decision}`, {
      confidencePercent: `${(confidence * 100).toFixed(0)}%`,
      regime: config.regime,
      marketState: analysis.marketState,
      reasoning: reasoning.substring(0, 100),
    });

    return {
      decision,
      confidence,
      reasoning,
      orderBookData: analysis,
      regime: config.regime,
    };
  } catch (error) {
    logger.error(`[OrderBookStrategy] Error analyzing ${symbol}`, error);
    return null;
  }
}

/**
 * Check if order book conditions are favorable for a given direction
 * Uses fallback config (static thresholds) for quick validation
 */
export function isOrderBookFavorable(
  analysis: OrderBookAnalysis,
  direction: 'BUY' | 'SELL'
): { favorable: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Imbalance check
  if (direction === 'BUY' && analysis.imbalanceRatio > FALLBACK_CONFIG.WEAK_IMBALANCE_THRESHOLD) {
    score += 30;
    reasons.push(`Imbalance favorevole BUY: ${(analysis.imbalanceRatio * 100).toFixed(1)}%`);
  } else if (direction === 'SELL' && analysis.imbalanceRatio < -FALLBACK_CONFIG.WEAK_IMBALANCE_THRESHOLD) {
    score += 30;
    reasons.push(`Imbalance favorevole SELL: ${(analysis.imbalanceRatio * 100).toFixed(1)}%`);
  }

  // Pressure check
  if (direction === 'BUY' && analysis.bidPressure > analysis.askPressure) {
    score += 20;
    reasons.push(`Bid pressure dominante: ${(analysis.bidPressure * 100).toFixed(1)}%`);
  } else if (direction === 'SELL' && analysis.askPressure > analysis.bidPressure) {
    score += 20;
    reasons.push(`Ask pressure dominante: ${(analysis.askPressure * 100).toFixed(1)}%`);
  }

  // Spread check
  if (analysis.spread < FALLBACK_CONFIG.MAX_SPREAD_PERCENT * 0.5) {
    score += 15;
    reasons.push(`Spread ottimo: ${analysis.spread.toFixed(4)}%`);
  } else if (analysis.spread < FALLBACK_CONFIG.MAX_SPREAD_PERCENT) {
    score += 10;
  }

  // Liquidity check
  if (analysis.liquidityScore >= 70) {
    score += 20;
    reasons.push(`Alta liquidità: ${analysis.liquidityScore}/100`);
  } else if (analysis.liquidityScore >= 50) {
    score += 10;
  }

  // Wall support check
  if (direction === 'BUY' && analysis.nearestBidWall &&
    analysis.nearestBidWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
    score += 15;
    reasons.push(`Wall supporto vicino`);
  }
  if (direction === 'SELL' && analysis.nearestAskWall &&
    analysis.nearestAskWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
    score += 15;
    reasons.push(`Wall resistenza vicino`);
  }

  return {
    favorable: score >= 50,
    score,
    reasons,
  };
}

export default {
  generateOrderBookSignal,
  isOrderBookFavorable,
  STATIC_CONFIG,
  FALLBACK_CONFIG,
};
