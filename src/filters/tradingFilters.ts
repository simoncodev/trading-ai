import { Indicators, MultiTimeframeIndicators } from '../types';
import { logger } from '../core/logger';

/**
 * Advanced trading filters to improve win rate and reduce noise trading
 */

// =====================================================
// 1. VOLATILITY & TREND FILTER (Anti-Chop)
// =====================================================

export interface VolatilityFilterResult {
  canTrade: boolean;
  reason: string;
  atrPercent: number;
  isVolatile: boolean;
  isTrending: boolean;
  trendDirection: 'bullish' | 'bearish' | 'neutral';
  trendStrength: number; // 0-100
}

/**
 * Filters out low-volatility choppy markets
 * @param _indicators Current indicators (kept for future use)
 * @param multiTf Multi-timeframe indicators
 * @param currentPrice Current market price
 */
export function checkVolatilityFilter(
  _indicators: Indicators,
  multiTf: MultiTimeframeIndicators,
  currentPrice: number
): VolatilityFilterResult {
  // Calculate ATR as percentage of price
  const atrPercent = (multiTf.atr.medium / currentPrice) * 100;
  
  // Minimum volatility threshold (0.005% ATR - ultra-low for 1-second scalping)
  // With 100x leverage, even 0.005% price move = 0.5% P&L
  const minVolatility = 0.005;
  const isVolatile = atrPercent >= minVolatility;

  // Trend strength from EMA alignment
  const emaAligned = 
    (multiTf.ema.scalping.trend === multiTf.ema.standard.trend) &&
    (multiTf.ema.standard.trend === multiTf.ema.swing.trend);
  
  // MACD alignment
  const macdAligned = 
    (multiTf.macd.fast.histogram > 0) === (multiTf.macd.standard.histogram > 0);

  // Calculate trend strength (0-100)
  let trendStrength = 0;
  if (emaAligned) trendStrength += 40;
  if (macdAligned) trendStrength += 30;
  if (Math.abs(multiTf.rsi.medium - 50) > 15) trendStrength += 20;
  if (multiTf.volume.isHigh) trendStrength += 10;

  const isTrending = trendStrength >= 50;

  // Determine trend direction
  let trendDirection: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (isTrending) {
    if (multiTf.ema.standard.trend === 'bullish' && multiTf.macd.standard.histogram > 0) {
      trendDirection = 'bullish';
    } else if (multiTf.ema.standard.trend === 'bearish' && multiTf.macd.standard.histogram < 0) {
      trendDirection = 'bearish';
    }
  }

  // Final decision
  let canTrade = true;
  let reason = 'Market conditions acceptable';

  if (!isVolatile) {
    canTrade = false;
    reason = `Low volatility (ATR ${atrPercent.toFixed(3)}% < ${minVolatility}%)`;
  }
  // Disable trend strength check for 1-second scalping
  // else if (!isTrending && trendStrength < 20) {
  //   canTrade = false;
  //   reason = `Choppy market (trend strength ${trendStrength}/100)`;
  // }

  return {
    canTrade,
    reason,
    atrPercent,
    isVolatile,
    isTrending,
    trendDirection,
    trendStrength,
  };
}

// =====================================================
// 2. TRADING SESSION FILTER
// =====================================================

export interface SessionInfo {
  name: string;
  isActive: boolean;
  volatilityMultiplier: number; // 1.0 = normal, 0.5 = reduce size, 1.5 = can increase
  shouldTrade: boolean;
  reason: string;
}

/**
 * Determines if current time is in a good trading session
 * Based on Fabio Valentino's model:
 * - New York session: Best for TREND FOLLOWING (high volatility)
 * - London session: Good for MEAN REVERSION (moderate volatility)
 * - Asia: Cautious trading
 */
export function checkTradingSession(): SessionInfo {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0 = Sunday

  // Weekend detection (generally lower liquidity)
  const isWeekend = utcDay === 0 || utcDay === 6;

  // Session definitions (UTC)
  let sessionName: string;
  let volatilityMultiplier: number;
  let shouldTrade: boolean;
  let reason: string;

  if (utcHour >= 0 && utcHour < 7) {
    // Asia session (00:00-07:00 UTC)
    // LOW VOLATILITY - be very selective
    sessionName = 'Asia';
    volatilityMultiplier = 0.6; // Reduced from 0.8
    shouldTrade = true;
    reason = 'Asia session - bassa volatilità, solo setup ad alta probabilità';
  } else if (utcHour >= 7 && utcHour < 13) {
    // London/Europe session (07:00-13:00 UTC)
    // MEAN REVERSION works well here
    sessionName = 'London';
    volatilityMultiplier = 1.0;
    shouldTrade = true;
    reason = 'London session - buona per mean reversion e breakout';
  } else if (utcHour >= 13 && utcHour < 21) {
    // New York session (13:00-21:00 UTC) - BEST FOR TREND FOLLOWING
    // This is where Fabio's model excels
    sessionName = 'NewYork';
    volatilityMultiplier = 1.4; // Increased from 1.2 - aggressive trading allowed
    shouldTrade = true;
    reason = 'New York session - MIGLIORE per trend following, alta volatilità';
  } else {
    // Late night (21:00-00:00 UTC)
    sessionName = 'LateNight';
    volatilityMultiplier = 0.4; // Reduced - very cautious
    shouldTrade = true;
    reason = 'Late night - ridurre size, bassa liquidità';
  }

  // Adjust for weekends - Fabio says avoid low volatility
  if (isWeekend) {
    volatilityMultiplier *= 0.5;
    reason += ' (weekend - evitare trading aggressivo)';
  }

  return {
    name: sessionName,
    isActive: true,
    volatilityMultiplier,
    shouldTrade,
    reason,
  };
}

// =====================================================
// 3. DYNAMIC POSITION SIZING
// =====================================================

export interface PositionSizeResult {
  sizeMultiplier: number; // 0.25 to 1.0
  reason: string;
  effectiveConfidence: number;
}

/**
 * Calculates dynamic position size based on confidence and market conditions
 * @param confidence AI confidence (0-1)
 * @param volatilityResult Volatility filter result
 * @param sessionInfo Trading session info
 * @param consecutiveLosses Number of consecutive losses
 */
export function calculateDynamicPositionSize(
  confidence: number,
  volatilityResult: VolatilityFilterResult,
  sessionInfo: SessionInfo,
  consecutiveLosses: number
): PositionSizeResult {
  let sizeMultiplier = 1.0;
  const reasons: string[] = [];

  // Base size from confidence
  if (confidence >= 0.85) {
    sizeMultiplier = 1.0;
    reasons.push('High confidence (100%)');
  } else if (confidence >= 0.75) {
    sizeMultiplier = 0.75;
    reasons.push('Good confidence (75%)');
  } else if (confidence >= 0.65) {
    sizeMultiplier = 0.5;
    reasons.push('Moderate confidence (50%)');
  } else {
    sizeMultiplier = 0.25;
    reasons.push('Low confidence (25%)');
  }

  // Adjust for trend strength
  if (volatilityResult.trendStrength >= 70) {
    sizeMultiplier *= 1.2; // Boost in strong trends
    reasons.push('Strong trend (+20%)');
  } else if (volatilityResult.trendStrength < 40) {
    sizeMultiplier *= 0.7; // Reduce in weak trends
    reasons.push('Weak trend (-30%)');
  }

  // Adjust for session
  sizeMultiplier *= sessionInfo.volatilityMultiplier;
  if (sessionInfo.volatilityMultiplier !== 1.0) {
    reasons.push(`${sessionInfo.name} session (${(sessionInfo.volatilityMultiplier * 100).toFixed(0)}%)`);
  }

  // Reduce after consecutive losses
  if (consecutiveLosses >= 3) {
    sizeMultiplier *= 0.5;
    reasons.push(`${consecutiveLosses} consecutive losses (-50%)`);
  } else if (consecutiveLosses >= 2) {
    sizeMultiplier *= 0.75;
    reasons.push(`${consecutiveLosses} consecutive losses (-25%)`);
  }

  // Cap between 0.1 and 1.0
  sizeMultiplier = Math.max(0.1, Math.min(1.0, sizeMultiplier));

  return {
    sizeMultiplier,
    reason: reasons.join(', '),
    effectiveConfidence: confidence * sizeMultiplier,
  };
}

// =====================================================
// 4. COOLDOWN AFTER LOSSES
// =====================================================

export interface CooldownResult {
  shouldWait: boolean;
  waitMinutes: number;
  reason: string;
  adjustedConfidenceThreshold: number;
}

// Track last loss time globally
let lastLossTime: number = 0;
let recentLossCount: number = 0;
let lastLossCheckTime: number = 0;

/**
 * Updates loss tracking when a trade closes in loss
 */
export function recordLoss(): void {
  lastLossTime = Date.now();
  
  // Reset counter if more than 1 hour since last loss
  if (Date.now() - lastLossCheckTime > 60 * 60 * 1000) {
    recentLossCount = 0;
  }
  
  recentLossCount++;
  lastLossCheckTime = Date.now();
  
  logger.warn('Loss recorded for cooldown tracking', {
    recentLossCount,
    lastLossTime: new Date(lastLossTime).toISOString(),
  });
}

/**
 * Resets loss counter (call after a win)
 */
export function recordWin(): void {
  recentLossCount = Math.max(0, recentLossCount - 1);
}

/**
 * Checks if we should wait before trading after losses
 * @param consecutiveLosses Number of consecutive losses from DB
 */
export function checkCooldown(consecutiveLosses: number): CooldownResult {
  const baseThreshold = 0.55; // Normal confidence threshold
  let adjustedThreshold = baseThreshold;
  let waitMinutes = 0;
  let shouldWait = false;
  let reason = 'No cooldown needed';

  // Calculate time since last loss
  const minutesSinceLastLoss = lastLossTime > 0 
    ? (Date.now() - lastLossTime) / (60 * 1000) 
    : Infinity;

  // Cooldown rules based on consecutive losses
  if (consecutiveLosses >= 5) {
    // After 5 losses: 15 min cooldown, +0.15 confidence required
    waitMinutes = 15;
    adjustedThreshold = baseThreshold + 0.15;
    reason = `5+ consecutive losses: ${waitMinutes}min cooldown, ${(adjustedThreshold * 100).toFixed(0)}% confidence required`;
  } else if (consecutiveLosses >= 3) {
    // After 3 losses: 5 min cooldown, +0.10 confidence required
    waitMinutes = 5;
    adjustedThreshold = baseThreshold + 0.10;
    reason = `3+ consecutive losses: ${waitMinutes}min cooldown, ${(adjustedThreshold * 100).toFixed(0)}% confidence required`;
  } else if (consecutiveLosses >= 2) {
    // After 2 losses: +0.05 confidence required
    adjustedThreshold = baseThreshold + 0.05;
    reason = `2+ consecutive losses: ${(adjustedThreshold * 100).toFixed(0)}% confidence required`;
  }

  // Check if still in cooldown period
  if (waitMinutes > 0 && minutesSinceLastLoss < waitMinutes) {
    shouldWait = true;
    reason = `Cooldown active: ${(waitMinutes - minutesSinceLastLoss).toFixed(1)} minutes remaining`;
  }

  return {
    shouldWait,
    waitMinutes,
    reason,
    adjustedConfidenceThreshold: adjustedThreshold,
  };
}

// =====================================================
// 5. FUNDING RATE / EVENT FILTER
// =====================================================

export interface EventFilterResult {
  shouldAvoid: boolean;
  reason: string;
  nextFundingIn: number; // minutes until next funding
}

/**
 * Checks if we should avoid trading due to upcoming events
 * Hyperliquid funding occurs every 8 hours at 00:00, 08:00, 16:00 UTC
 */
export function checkEventFilter(): EventFilterResult {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();

  // Funding times in UTC hours
  const fundingHours = [0, 8, 16];
  
  // Find next funding time
  let nextFundingHour = fundingHours.find(h => h > utcHour) || fundingHours[0] + 24;
  const minutesUntilFunding = (nextFundingHour - utcHour) * 60 - utcMinute;

  // Avoid trading 10 minutes before and 5 minutes after funding
  const avoidBeforeFunding = 10;
  const avoidAfterFunding = 5;

  let shouldAvoid = false;
  let reason = 'No events affecting trading';

  if (minutesUntilFunding <= avoidBeforeFunding) {
    shouldAvoid = true;
    reason = `Funding in ${minutesUntilFunding} minutes - avoid new positions`;
  } else if (minutesUntilFunding >= (8 * 60 - avoidAfterFunding)) {
    // Just after funding (within 5 minutes)
    shouldAvoid = true;
    reason = 'Just after funding settlement - waiting for stability';
  }

  return {
    shouldAvoid,
    reason,
    nextFundingIn: minutesUntilFunding,
  };
}

// =====================================================
// 6. VOLUME SPIKE DETECTION (Anomaly Filter)
// =====================================================

export interface VolumeAnomalyResult {
  isAnomaly: boolean;
  volumeRatio: number;
  reason: string;
  recommendation: 'trade' | 'reduce_size' | 'skip';
}

/**
 * Detects abnormal volume spikes that might indicate manipulation or news
 * @param multiTf Multi-timeframe indicators with volume data
 */
export function checkVolumeAnomaly(multiTf: MultiTimeframeIndicators): VolumeAnomalyResult {
  const volumeRatio = multiTf.volume.ratio;
  
  let isAnomaly = false;
  let recommendation: 'trade' | 'reduce_size' | 'skip' = 'trade';
  let reason = 'Normal volume';

  if (volumeRatio >= 5.0) {
    // Extreme spike (5x average) - likely news/manipulation
    isAnomaly = true;
    recommendation = 'skip';
    reason = `Extreme volume spike (${volumeRatio.toFixed(1)}x) - possible news event`;
  } else if (volumeRatio >= 3.0) {
    // High spike (3x average) - proceed with caution
    isAnomaly = true;
    recommendation = 'reduce_size';
    reason = `High volume spike (${volumeRatio.toFixed(1)}x) - reduce position size`;
  } else if (volumeRatio >= 1.5) {
    // Good volume - favorable for trading
    isAnomaly = false;
    recommendation = 'trade';
    reason = `Good volume (${volumeRatio.toFixed(1)}x) - favorable conditions`;
  } else if (volumeRatio < 0.5) {
    // Very low volume - less reliable signals
    isAnomaly = false;
    recommendation = 'reduce_size';
    reason = `Low volume (${volumeRatio.toFixed(1)}x) - reduced reliability`;
  }

  return {
    isAnomaly,
    volumeRatio,
    reason,
    recommendation,
  };
}

// =====================================================
// 7. MASTER FILTER - Combines all filters
// =====================================================

export interface MasterFilterResult {
  canTrade: boolean;
  finalSizeMultiplier: number;
  adjustedConfidenceThreshold: number;
  reasons: string[];
  filters: {
    volatility: VolatilityFilterResult;
    session: SessionInfo;
    positionSize: PositionSizeResult;
    cooldown: CooldownResult;
    event: EventFilterResult;
    volumeAnomaly: VolumeAnomalyResult;
  };
}

/**
 * Master filter that combines all individual filters
 * Returns final trading decision with adjusted parameters
 */
export function applyMasterFilter(
  indicators: Indicators,
  multiTf: MultiTimeframeIndicators,
  currentPrice: number,
  aiConfidence: number,
  consecutiveLosses: number
): MasterFilterResult {
  const reasons: string[] = [];
  let canTrade = true;
  let finalSizeMultiplier = 1.0;

  // 1. Volatility Filter
  const volatility = checkVolatilityFilter(indicators, multiTf, currentPrice);
  if (!volatility.canTrade) {
    canTrade = false;
    reasons.push(`❌ Volatility: ${volatility.reason}`);
  } else {
    reasons.push(`✅ Volatility: ${volatility.reason}`);
  }

  // 2. Session Filter
  const session = checkTradingSession();
  if (!session.shouldTrade) {
    canTrade = false;
    reasons.push(`❌ Session: ${session.reason}`);
  } else {
    reasons.push(`✅ Session: ${session.reason}`);
  }

  // 3. Cooldown Check
  const cooldown = checkCooldown(consecutiveLosses);
  if (cooldown.shouldWait) {
    canTrade = false;
    reasons.push(`❌ Cooldown: ${cooldown.reason}`);
  } else if (cooldown.adjustedConfidenceThreshold > 0.55) {
    reasons.push(`⚠️ Cooldown: ${cooldown.reason}`);
  }

  // 4. Event Filter
  const event = checkEventFilter();
  if (event.shouldAvoid) {
    canTrade = false;
    reasons.push(`❌ Event: ${event.reason}`);
  } else {
    reasons.push(`✅ Event: ${event.reason}`);
  }

  // 5. Volume Anomaly
  const volumeAnomaly = checkVolumeAnomaly(multiTf);
  if (volumeAnomaly.recommendation === 'skip') {
    canTrade = false;
    reasons.push(`❌ Volume: ${volumeAnomaly.reason}`);
  } else if (volumeAnomaly.recommendation === 'reduce_size') {
    finalSizeMultiplier *= 0.5;
    reasons.push(`⚠️ Volume: ${volumeAnomaly.reason}`);
  } else {
    reasons.push(`✅ Volume: ${volumeAnomaly.reason}`);
  }

  // 6. Calculate Dynamic Position Size
  const positionSize = calculateDynamicPositionSize(
    aiConfidence,
    volatility,
    session,
    consecutiveLosses
  );
  finalSizeMultiplier *= positionSize.sizeMultiplier;
  reasons.push(`📊 Position size: ${(finalSizeMultiplier * 100).toFixed(0)}% (${positionSize.reason})`);

  // Log the filter results
  logger.info('Master filter applied', {
    canTrade,
    finalSizeMultiplier: finalSizeMultiplier.toFixed(2),
    adjustedThreshold: cooldown.adjustedConfidenceThreshold,
    volatilityOk: volatility.canTrade,
    sessionOk: session.shouldTrade,
    cooldownOk: !cooldown.shouldWait,
    eventOk: !event.shouldAvoid,
    volumeOk: volumeAnomaly.recommendation !== 'skip',
  });

  return {
    canTrade,
    finalSizeMultiplier,
    adjustedConfidenceThreshold: cooldown.adjustedConfidenceThreshold,
    reasons,
    filters: {
      volatility,
      session,
      positionSize,
      cooldown,
      event,
      volumeAnomaly,
    },
  };
}

// =====================================================
// 8. SIGNAL DIRECTION ALIGNMENT
// =====================================================

/**
 * Checks if AI decision aligns with trend direction
 * @param decision AI decision (BUY/SELL)
 * @param volatility Volatility filter result
 * @returns Whether the signal aligns with trend
 */
export function checkSignalAlignment(
  decision: 'BUY' | 'SELL' | 'HOLD',
  volatility: VolatilityFilterResult
): { aligned: boolean; reason: string } {
  if (decision === 'HOLD') {
    return { aligned: true, reason: 'HOLD decision - no alignment needed' };
  }

  const trendDirection = volatility.trendDirection;
  
  if (trendDirection === 'neutral') {
    return { 
      aligned: true, 
      reason: 'Neutral trend - any direction acceptable' 
    };
  }

  const signalDirection = decision === 'BUY' ? 'bullish' : 'bearish';
  const aligned = signalDirection === trendDirection;

  return {
    aligned,
    reason: aligned 
      ? `Signal ${decision} aligns with ${trendDirection} trend`
      : `⚠️ Signal ${decision} AGAINST ${trendDirection} trend (counter-trend)`,
  };
}
