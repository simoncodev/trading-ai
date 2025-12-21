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

// =====================================================
// ELITE SCALPER: COOLDOWN E TRADE LIMITING
// =====================================================

// Track last loss time globally
let lastLossTime: number = 0;
let recentLossCount: number = 0;
let lastLossCheckTime: number = 0;

// NUOVO: Track ultimo trade (qualsiasi risultato)
let lastTradeTime: number = 0;
let dailyTradeCount: number = 0;
let lastDailyReset: string = '';

// ELITE SETTINGS: Meno trade = trade migliori
const ELITE_CONFIG = {
  MIN_TIME_BETWEEN_TRADES_MS: 3 * 60 * 1000,  // 3 minuti tra un trade e l'altro
  MAX_DAILY_TRADES: 15,                         // Max 15 trade al giorno
  COOLDOWN_AFTER_LOSS_MS: 5 * 60 * 1000,       // 5 min dopo una loss
  COOLDOWN_AFTER_2_LOSSES_MS: 10 * 60 * 1000,  // 10 min dopo 2 losses
  COOLDOWN_AFTER_3_LOSSES_MS: 30 * 60 * 1000,  // 30 min dopo 3+ losses
};

/**
 * Registra un trade eseguito
 */
export function recordTradeExecuted(): void {
  lastTradeTime = Date.now();
  
  // Reset daily counter if new day
  const today = new Date().toDateString();
  if (today !== lastDailyReset) {
    dailyTradeCount = 0;
    lastDailyReset = today;
  }
  
  dailyTradeCount++;
  
  logger.info('📊 Trade recorded', {
    dailyTradeCount,
    maxDaily: ELITE_CONFIG.MAX_DAILY_TRADES,
    lastTradeTime: new Date(lastTradeTime).toISOString(),
  });
}

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
 * ELITE VERSION: Include time-based cooldown tra trade
 * @param consecutiveLosses Number of consecutive losses from DB
 */
export function checkCooldown(consecutiveLosses: number): CooldownResult {
  const baseThreshold = 0.65; // RAISED: Confidence minima più alta
  let adjustedThreshold = baseThreshold;
  let waitMinutes = 0;
  let shouldWait = false;
  let reason = 'No cooldown needed';

  // Reset daily counter if new day
  const today = new Date().toDateString();
  if (today !== lastDailyReset) {
    dailyTradeCount = 0;
    lastDailyReset = today;
  }

  // ========================================
  // CHECK 1: Daily trade limit
  // ========================================
  if (dailyTradeCount >= ELITE_CONFIG.MAX_DAILY_TRADES) {
    shouldWait = true;
    reason = `⛔ Daily limit reached: ${dailyTradeCount}/${ELITE_CONFIG.MAX_DAILY_TRADES} trades`;
    return { shouldWait, waitMinutes: 999, reason, adjustedConfidenceThreshold: 1.0 };
  }

  // ========================================
  // CHECK 2: Minimum time between trades
  // ========================================
  const msSinceLastTrade = lastTradeTime > 0 ? Date.now() - lastTradeTime : Infinity;
  if (msSinceLastTrade < ELITE_CONFIG.MIN_TIME_BETWEEN_TRADES_MS) {
    const remainingMs = ELITE_CONFIG.MIN_TIME_BETWEEN_TRADES_MS - msSinceLastTrade;
    waitMinutes = remainingMs / (60 * 1000);
    shouldWait = true;
    reason = `⏳ Cooldown tra trade: ${waitMinutes.toFixed(1)} min rimanenti`;
    return { shouldWait, waitMinutes, reason, adjustedConfidenceThreshold: baseThreshold };
  }

  // Calculate time since last loss
  const msSinceLastLoss = lastLossTime > 0 ? Date.now() - lastLossTime : Infinity;

  // ========================================
  // CHECK 3: Consecutive losses cooldown (AGGRESSIVE)
  // ========================================
  if (consecutiveLosses >= 3 || recentLossCount >= 3) {
    const cooldownMs = ELITE_CONFIG.COOLDOWN_AFTER_3_LOSSES_MS;
    if (msSinceLastLoss < cooldownMs) {
      waitMinutes = (cooldownMs - msSinceLastLoss) / (60 * 1000);
      shouldWait = true;
      adjustedThreshold = 0.90; // Richiedi 90% confidence dopo 3 losses
      reason = `🛑 3+ losses: ${waitMinutes.toFixed(1)}min cooldown, richiesto ${(adjustedThreshold * 100).toFixed(0)}% confidence`;
      return { shouldWait, waitMinutes, reason, adjustedConfidenceThreshold: adjustedThreshold };
    }
    adjustedThreshold = 0.85;
    reason = `⚠️ Post 3+ losses: ${(adjustedThreshold * 100).toFixed(0)}% confidence richiesta`;
  } else if (consecutiveLosses >= 2 || recentLossCount >= 2) {
    const cooldownMs = ELITE_CONFIG.COOLDOWN_AFTER_2_LOSSES_MS;
    if (msSinceLastLoss < cooldownMs) {
      waitMinutes = (cooldownMs - msSinceLastLoss) / (60 * 1000);
      shouldWait = true;
      adjustedThreshold = 0.80;
      reason = `⚠️ 2 losses: ${waitMinutes.toFixed(1)}min cooldown, richiesto ${(adjustedThreshold * 100).toFixed(0)}% confidence`;
      return { shouldWait, waitMinutes, reason, adjustedConfidenceThreshold: adjustedThreshold };
    }
    adjustedThreshold = 0.75;
    reason = `Post 2 losses: ${(adjustedThreshold * 100).toFixed(0)}% confidence richiesta`;
  } else if (consecutiveLosses >= 1 || recentLossCount >= 1) {
    const cooldownMs = ELITE_CONFIG.COOLDOWN_AFTER_LOSS_MS;
    if (msSinceLastLoss < cooldownMs) {
      waitMinutes = (cooldownMs - msSinceLastLoss) / (60 * 1000);
      shouldWait = true;
      reason = `⏳ Post-loss cooldown: ${waitMinutes.toFixed(1)}min rimanenti`;
      return { shouldWait, waitMinutes, reason, adjustedConfidenceThreshold: baseThreshold + 0.05 };
    }
    adjustedThreshold = baseThreshold + 0.05;
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
