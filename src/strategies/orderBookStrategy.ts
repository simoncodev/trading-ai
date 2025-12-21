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
const FALLBACK_CONFIG = {
  STRONG_IMBALANCE_THRESHOLD: 0.35,
  WEAK_IMBALANCE_THRESHOLD: 0.22,
  MAX_SPREAD_PERCENT: 0.12,
  MIN_LIQUIDITY_SCORE: 45,
  PRESSURE_THRESHOLD: 0.58,
  MIN_TRADE_CONFIDENCE: 0.55,
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

    // Log order book data with regime
    logger.info(`📊 [${symbol}] Order Book (${config.regime}):`, {
      imbalance: `${(analysis.imbalanceRatio * 100).toFixed(1)}%`,
      signal: analysis.imbalanceSignal,
      spread: `${analysis.spread.toFixed(4)}%`,
      bidPressure: `${(analysis.bidPressure * 100).toFixed(1)}%`,
      askPressure: `${(analysis.askPressure * 100).toFixed(1)}%`,
      liquidity: analysis.liquidityScore,
    });

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
    
    // Add regime to reasoning
    reasons.push(`[${config.regime}]`);

    // Strong imbalance signal (using adaptive threshold)
    if (absImbalance >= config.strongImbalance) {
      decision = imbalance > 0 ? 'BUY' : 'SELL';
      // Base confidence 50% + bonus per imbalance extra
      confidence = 0.50 + (absImbalance - config.strongImbalance) * 0.6;
      reasons.push(`Forte imbalance ${decision === 'BUY' ? 'BID' : 'ASK'}: ${(imbalance * 100).toFixed(1)}%`);
    }
    // Weak imbalance - need confirmation
    else if (absImbalance >= config.weakImbalance) {
      const potentialDecision = imbalance > 0 ? 'BUY' : 'SELL';
      // Base confidence 42% + bonus per imbalance
      confidence = 0.42 + (absImbalance - config.weakImbalance) * 0.9;
      reasons.push(`Imbalance moderato ${potentialDecision === 'BUY' ? 'BID' : 'ASK'}: ${(imbalance * 100).toFixed(1)}%`);
      
      // Need pressure confirmation for weak imbalance
      const pressureConfirms = 
        (potentialDecision === 'BUY' && analysis.bidPressure > config.pressureThreshold) ||
        (potentialDecision === 'SELL' && analysis.askPressure > config.pressureThreshold);
      
      if (pressureConfirms) {
        decision = potentialDecision;
        confidence += STATIC_CONFIG.PRESSURE_CONFIDENCE_BOOST;
        reasons.push(`Pressione conferma: ${potentialDecision === 'BUY' ? 'BID' : 'ASK'} ${((potentialDecision === 'BUY' ? analysis.bidPressure : analysis.askPressure) * 100).toFixed(1)}%`);
      }
    }

    // Additional confidence boosts
    if (decision !== 'HOLD') {
      // Check for supportive walls
      if (decision === 'BUY' && analysis.nearestBidWall && 
          analysis.nearestBidWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
        confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
        reasons.push(`Wall supporto: $${analysis.nearestBidWall.price.toFixed(2)} (${analysis.nearestBidWall.distancePercent.toFixed(2)}% sotto)`);
      }
      if (decision === 'SELL' && analysis.nearestAskWall && 
          analysis.nearestAskWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
        confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
        reasons.push(`Wall resistenza: $${analysis.nearestAskWall.price.toFixed(2)} (${analysis.nearestAskWall.distancePercent.toFixed(2)}% sopra)`);
      }

      // Check momentum (if available) - RILASSATO: solo bonus, non blocca
      const momentum = orderBookAnalyzer.getImbalanceMomentum(symbol);
      const momentumAligns = 
        (decision === 'BUY' && momentum > 0.05) ||
        (decision === 'SELL' && momentum < -0.05);
      
      // Momentum opposto = penalità invece di blocco totale
      const momentumOpposed = 
        (decision === 'BUY' && momentum < -0.10) ||
        (decision === 'SELL' && momentum > 0.10);
      
      if (momentumOpposed) {
        confidence -= 0.10;
        reasons.push(`⚠️ Momentum contrario (${(momentum * 100).toFixed(1)}%) - confidence ridotta`);
      } else if (momentumAligns) {
        confidence += STATIC_CONFIG.MOMENTUM_CONFIDENCE_BOOST;
        reasons.push(`Momentum ${momentum > 0 ? 'positivo' : 'negativo'}: ${(momentum * 100).toFixed(1)}%`);
      }

      // Pressure alignment boost for strong imbalance
      const pressureAligns = 
        (decision === 'BUY' && analysis.bidPressure > analysis.askPressure) ||
        (decision === 'SELL' && analysis.askPressure > analysis.bidPressure);
    
      if (pressureAligns && absImbalance >= config.strongImbalance) {
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
