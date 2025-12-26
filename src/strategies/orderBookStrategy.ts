import { logger } from '../core/logger';
import { orderBookAnalyzer, OrderBookAnalysis } from '../services/orderBookAnalyzer';
import { adaptiveParams } from '../services/adaptiveParameters';
import { marketDataService } from '../services/marketDataService';
import { indicatorService } from './indicators';
import { liquidityTracker } from '../services/liquidityTracker';

/**
 * Order Book Trading Strategy - Pure order book based trading
 * Now with ADAPTIVE PARAMETERS based on market regime
 * + MACRO TREND FILTER to avoid counter-trend trades
 * + LIQUIDITY WAVE SURFING for better entry timing
 */

// ========================================
// MACRO TREND TRACKING
// ========================================
interface MacroTrend {
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number; // 0-100
  lastUpdate: number;
  priceChange1h: number;
  priceChange4h: number;
}

const macroTrendCache: Map<string, MacroTrend> = new Map();
const MACRO_TREND_CACHE_TTL = 60000; // 1 minute cache

/**
 * Get macro trend for a symbol
 * Uses EMA crossovers and price change to determine trend
 */
async function getMacroTrend(symbol: string): Promise<MacroTrend> {
  const cached = macroTrendCache.get(symbol);
  if (cached && Date.now() - cached.lastUpdate < MACRO_TREND_CACHE_TTL) {
    return cached;
  }

  try {
    const candles = await marketDataService.getCandles(symbol, '1m', 240); // 4 ore di dati
    if (!candles || candles.length < 60) {
      return { direction: 'NEUTRAL', strength: 0, lastUpdate: Date.now(), priceChange1h: 0, priceChange4h: 0 };
    }

    const currentPrice = candles[candles.length - 1].close;
    
    // Price change 1h (60 candele da 1min)
    const price1hAgo = candles[Math.max(0, candles.length - 60)].close;
    const priceChange1h = ((currentPrice - price1hAgo) / price1hAgo) * 100;
    
    // Price change 4h (240 candele da 1min)
    const price4hAgo = candles[0].close;
    const priceChange4h = ((currentPrice - price4hAgo) / price4hAgo) * 100;

    // Get multi-timeframe indicators for EMA trend
    const multiTf = await indicatorService.getMultiTimeframeIndicators(candles, currentPrice);
    
    // Calculate trend strength
    let bullishSignals = 0;
    let bearishSignals = 0;

    // EMA trends
    if (multiTf.ema.scalping.trend === 'bullish') bullishSignals++;
    else if (multiTf.ema.scalping.trend === 'bearish') bearishSignals++;
    
    if (multiTf.ema.standard.trend === 'bullish') bullishSignals++;
    else if (multiTf.ema.standard.trend === 'bearish') bearishSignals++;
    
    if (multiTf.ema.swing.trend === 'bullish') bullishSignals++;
    else if (multiTf.ema.swing.trend === 'bearish') bearishSignals++;

    // MACD
    if (multiTf.macd.standard.histogram > 0) bullishSignals++;
    else bearishSignals++;

    // Price change direction
    if (priceChange1h > 0.1) bullishSignals++;
    else if (priceChange1h < -0.1) bearishSignals++;
    
    if (priceChange4h > 0.2) bullishSignals++;
    else if (priceChange4h < -0.2) bearishSignals++;

    // Determine direction and strength
    let direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let strength = 0;

    const totalSignals = bullishSignals + bearishSignals;
    if (totalSignals > 0) {
      if (bullishSignals > bearishSignals + 1) {
        direction = 'BULLISH';
        strength = (bullishSignals / 6) * 100; // 6 total possible signals
      } else if (bearishSignals > bullishSignals + 1) {
        direction = 'BEARISH';
        strength = (bearishSignals / 6) * 100;
      }
    }

    const trend: MacroTrend = {
      direction,
      strength,
      lastUpdate: Date.now(),
      priceChange1h,
      priceChange4h,
    };

    macroTrendCache.set(symbol, trend);
    return trend;
  } catch (error) {
    logger.warn(`Failed to get macro trend for ${symbol}`, { error: String(error) });
    return { direction: 'NEUTRAL', strength: 0, lastUpdate: Date.now(), priceChange1h: 0, priceChange4h: 0 };
  }
}

export interface OrderBookSignal {
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  orderBookData: OrderBookAnalysis;
  regime?: string;  // Market regime used
}

// Static config (non-adaptive)
const STATIC_CONFIG = {
  // Wall detection - più stringente
  WALL_DISTANCE_THRESHOLD: 0.12,     // Wall within 0.12% = molto significativo

  // Confidence boosts - aumentati
  WALL_CONFIDENCE_BOOST: 0.10,       // +10% confidence if wall supports trade
  PRESSURE_CONFIDENCE_BOOST: 0.08,   // +8% confidence if pressure aligns
  MOMENTUM_CONFIDENCE_BOOST: 0.08,   // +8% confidence if momentum aligns
  
  // CONFLUENZE MINIME RICHIESTE - AUMENTATE
  MIN_CONFLUENCES_FOR_TRADE: 4,      // Almeno 4 segnali allineati (era 3)
};

// Fallback config - ELITE SCALPER SETTINGS
// REGOLA: Solo setup A+ con altissima probabilità
const FALLBACK_CONFIG = {
  STRONG_IMBALANCE_THRESHOLD: 0.55,   // Aumentato: serve imbalance molto forte
  WEAK_IMBALANCE_THRESHOLD: 0.40,     // Aumentato: evita segnali deboli
  MAX_SPREAD_PERCENT: 0.06,           // Ridotto: solo mercati molto liquidi
  MIN_LIQUIDITY_SCORE: 70,            // Aumentato: serve liquidità alta
  PRESSURE_THRESHOLD: 0.70,           // Aumentato: serve pressione chiara
  MIN_TRADE_CONFIDENCE: 0.85,         // CRITICO: Solo trade ad altissima confidence
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

    // CONSOLIDATION: ASSOLUTAMENTE NON TRADARE
    if (analysis.marketState === 'CONSOLIDATION') {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `🚫 [CONSOLIDATION] NO TRADE - mercato senza direzione, aspetta breakout`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // BALANCED: Evita anche questo - aspetta imbalance
    if (analysis.marketState === 'BALANCED' && !analysis.breakoutConfirmed) {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `⏸️ [BALANCED] NO TRADE - aspetta conferma breakout o imbalance`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // ABSORPTION DETECTED: Potential reversal - NON ENTRARE
    if (analysis.absorptionDetected) {
      logger.warn(`⚠️ [${symbol}] ABSORPTION DETECTED - Big orders no follow-through`);
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `🧱 [ABSORPTION] NO TRADE - ordini grandi assorbiti, possibile inversione`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // ========================================
    // MACRO TREND FILTER - CRITICAL
    // Avoid counter-trend trades in strong trends
    // ========================================
    const macroTrend = await getMacroTrend(symbol);
    logger.debug(`📈 [${symbol}] Macro Trend: ${macroTrend.direction} (${macroTrend.strength.toFixed(0)}%)`, {
      priceChange1h: `${macroTrend.priceChange1h.toFixed(2)}%`,
      priceChange4h: `${macroTrend.priceChange4h.toFixed(2)}%`,
    });

    // Check basic requirements (using adaptive params) - PIÙ STRINGENTI
    if (analysis.spread > config.maxSpread) {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `📊 Spread troppo alto (${analysis.spread.toFixed(4)}% > ${config.maxSpread}%) - mercato illiquido`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    if (analysis.liquidityScore < config.minLiquidity) {
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `💧 Liquidità bassa (${analysis.liquidityScore} < ${config.minLiquidity}) - rischio slippage`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // ========================================
    // SISTEMA CONFLUENZE - SCALPER ELITE
    // Conta quanti segnali sono allineati
    // ========================================
    let confluences = 0;
    const confluenceDetails: string[] = [];

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
    // SOLO IMBALANCED MARKET - TREND FOLLOWING
    // "In uptrend only BUY, in downtrend only SELL"
    // ========================================
    if (analysis.marketState === 'IMBALANCED_UP' || analysis.marketState === 'IMBALANCED_DOWN') {
      const expectedDirection = analysis.marketState === 'IMBALANCED_UP' ? 'BUY' : 'SELL';

      // CONFLUENZA 1: Market State (già verificato)
      confluences++;
      confluenceDetails.push(`✅ Market State: ${analysis.marketState}`);

      // CONFLUENZA 2: Imbalance forte nella direzione giusta
      if (absImbalance >= config.weakImbalance) {
        const imbalanceDirection = imbalance > 0 ? 'BUY' : 'SELL';

        if (imbalanceDirection === expectedDirection) {
          // ⚠️ CRITICAL CHECK: Aggression must NOT be strongly opposite
          const aggressionOpposed =
            (expectedDirection === 'BUY' && analysis.aggressionScore < -0.30) ||
            (expectedDirection === 'SELL' && analysis.aggressionScore > 0.30);

          if (aggressionOpposed) {
            logger.warn(`⛔ [${symbol}] IMBALANCED REJECTED - Aggression strongly OPPOSED (${(analysis.aggressionScore * 100).toFixed(0)}%)`, {
              expectedDirection,
              aggressionScore: analysis.aggressionScore,
              marketState: analysis.marketState,
            });
            return {
              decision: 'HOLD',
              confidence: 0,
              reasoning: `⛔ IMBALANCED ${analysis.marketState} REJECTED - Aggression ${(analysis.aggressionScore * 100).toFixed(0)}% strongly OPPOSED`,
              orderBookData: analysis,
              regime: config.regime,
            };
          }

          confluences++;
          confluenceDetails.push(`✅ Imbalance: ${(imbalance * 100).toFixed(1)}% verso ${expectedDirection}`);
          
          decision = expectedDirection;
          // Base confidence più alta in mercato imbalanced
          confidence = 0.60 + (absImbalance - config.weakImbalance) * 0.6;
          reasons.push(`📈 TREND: ${expectedDirection}`);

          // CONFLUENZA 3: Aggression allineata
          const aggressionAligns =
            (decision === 'BUY' && analysis.aggressionScore > 0.25) ||
            (decision === 'SELL' && analysis.aggressionScore < -0.25);

          if (aggressionAligns) {
            confluences++;
            confluenceDetails.push(`✅ Aggression: ${(analysis.aggressionScore * 100).toFixed(0)}%`);
            confidence += 0.10;
            reasons.push(`🔥 Aggression confirms`);
          }

          // CONFLUENZA 4: Pressure allineata
          const pressureAligns =
            (decision === 'BUY' && analysis.bidPressure > analysis.askPressure + 0.1) ||
            (decision === 'SELL' && analysis.askPressure > analysis.bidPressure + 0.1);

          if (pressureAligns) {
            confluences++;
            confluenceDetails.push(`✅ Pressure: Bid ${(analysis.bidPressure * 100).toFixed(0)}% vs Ask ${(analysis.askPressure * 100).toFixed(0)}%`);
            confidence += STATIC_CONFIG.PRESSURE_CONFIDENCE_BOOST;
          }

          // CONFLUENZA 5: Breakout confirmed (second drive)
          if (analysis.breakoutConfirmed) {
            confluences++;
            confluenceDetails.push(`✅ Second Drive CONFIRMED`);
            confidence += 0.15;
            reasons.push(`🎯 SECOND DRIVE - alta probabilità`);
          }

          // CONFLUENZA 6: Wall support
          if (decision === 'BUY' && analysis.nearestBidWall &&
            analysis.nearestBidWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
            confluences++;
            confluenceDetails.push(`✅ Wall supporto @ $${analysis.nearestBidWall.price.toFixed(2)}`);
            confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
          }
          if (decision === 'SELL' && analysis.nearestAskWall &&
            analysis.nearestAskWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
            confluences++;
            confluenceDetails.push(`✅ Wall resistenza @ $${analysis.nearestAskWall.price.toFixed(2)}`);
            confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
          }

          // CONFLUENZA 7: Low Volume Node
          if (analysis.lowVolumeNode) {
            confluences++;
            confluenceDetails.push(`✅ LVN @ $${analysis.lowVolumeNode.price.toFixed(2)}`);
            confidence += 0.08;
          }

        } else {
          reasons.push(`⛔ Imbalance opposto a market state - NO TRADE`);
          decision = 'HOLD';
          confidence = 0;
        }
      } else {
        reasons.push(`⚠️ Imbalance troppo debole (${(absImbalance * 100).toFixed(1)}% < ${(config.weakImbalance * 100).toFixed(0)}%)`);
      }
    }
    // ========================================
    // BALANCED CON BREAKOUT CONFIRMED - Entry cauto
    // ========================================
    else if (analysis.marketState === 'BALANCED' && analysis.breakoutConfirmed) {
      decision = imbalance > 0 ? 'BUY' : 'SELL';
      confidence = 0.65 + absImbalance * 0.3;
      confluences = 2; // Breakout + direction
      confluenceDetails.push(`✅ Breakout confirmed in balanced`);
      confluenceDetails.push(`✅ Direction: ${decision}`);
      reasons.push(`🎯 BREAKOUT CONFIRMED - entry cauto`);

      // ⚠️ CRITICAL CHECK: Aggression must NOT be opposite to decision
      // Se l'aggression è fortemente opposta, il breakout è falso!
      const aggressionOpposed =
        (decision === 'BUY' && analysis.aggressionScore < -0.20) ||
        (decision === 'SELL' && analysis.aggressionScore > 0.20);

      if (aggressionOpposed) {
        logger.warn(`⛔ [${symbol}] BALANCED BREAKOUT REJECTED - Aggression OPPOSED (${(analysis.aggressionScore * 100).toFixed(0)}%)`, {
          decision,
          aggressionScore: analysis.aggressionScore,
        });
        return {
          decision: 'HOLD',
          confidence: 0,
          reasoning: `⛔ BALANCED BREAKOUT REJECTED - Aggression ${(analysis.aggressionScore * 100).toFixed(0)}% OPPOSED to ${decision}`,
          orderBookData: analysis,
          regime: config.regime,
        };
      }

      // Aggiungi confluenze extra per BALANCED BREAKOUT (stesso check degli IMBALANCED)
      // CONFLUENZA 3: Aggression allineata
      const aggressionAligns =
        (decision === 'BUY' && analysis.aggressionScore > 0.25) ||
        (decision === 'SELL' && analysis.aggressionScore < -0.25);

      if (aggressionAligns) {
        confluences++;
        confluenceDetails.push(`✅ Aggression: ${(analysis.aggressionScore * 100).toFixed(0)}%`);
        confidence += 0.10;
        reasons.push(`🔥 Aggression confirms`);
      }

      // CONFLUENZA 4: Pressure allineata
      const pressureAligns =
        (decision === 'BUY' && analysis.bidPressure > analysis.askPressure + 0.1) ||
        (decision === 'SELL' && analysis.askPressure > analysis.bidPressure + 0.1);

      if (pressureAligns) {
        confluences++;
        confluenceDetails.push(`✅ Pressure: Bid ${(analysis.bidPressure * 100).toFixed(0)}% vs Ask ${(analysis.askPressure * 100).toFixed(0)}%`);
        confidence += STATIC_CONFIG.PRESSURE_CONFIDENCE_BOOST;
      }

      // CONFLUENZA 5: Wall support
      if (decision === 'BUY' && analysis.nearestBidWall &&
        analysis.nearestBidWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
        confluences++;
        confluenceDetails.push(`✅ Wall supporto @ $${analysis.nearestBidWall.price.toFixed(2)}`);
        confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
      }
      if (decision === 'SELL' && analysis.nearestAskWall &&
        analysis.nearestAskWall.distancePercent < STATIC_CONFIG.WALL_DISTANCE_THRESHOLD) {
        confluences++;
        confluenceDetails.push(`✅ Wall resistenza @ $${analysis.nearestAskWall.price.toFixed(2)}`);
        confidence += STATIC_CONFIG.WALL_CONFIDENCE_BOOST;
      }

      // CONFLUENZA 6: Low Volume Node
      if (analysis.lowVolumeNode) {
        confluences++;
        confluenceDetails.push(`✅ LVN @ $${analysis.lowVolumeNode.price.toFixed(2)}`);
        confidence += 0.08;
      }
    }

    // ========================================
    // MOMENTUM CHECK - CRITICO
    // ========================================
    if (decision !== 'HOLD') {
      const momentum = orderBookAnalyzer.getImbalanceMomentum(symbol);
      
      // Momentum OPPOSTO = KILL THE TRADE
      const momentumOpposed =
        (decision === 'BUY' && momentum < -0.15) ||
        (decision === 'SELL' && momentum > 0.15);

      if (momentumOpposed) {
        logger.warn(`⛔ [${symbol}] Momentum OPPOSTO - TRADE KILLED`, { momentum });
        return {
          decision: 'HOLD',
          confidence: 0,
          reasoning: `⛔ MOMENTUM CONTRARIO (${(momentum * 100).toFixed(1)}%) - Trade annullato`,
          orderBookData: analysis,
          regime: config.regime,
        };
      }

      // Momentum allineato = bonus
      const momentumAligns =
        (decision === 'BUY' && momentum > 0.08) ||
        (decision === 'SELL' && momentum < -0.08);

      if (momentumAligns) {
        confluences++;
        confluenceDetails.push(`✅ Momentum: ${(momentum * 100).toFixed(1)}%`);
        confidence += STATIC_CONFIG.MOMENTUM_CONFIDENCE_BOOST;
        reasons.push(`📊 Momentum +${(momentum * 100).toFixed(1)}%`);
      }
    }

    // ========================================
    // MACRO TREND FILTER - BLOCK COUNTER-TREND
    // ========================================
    if (decision !== 'HOLD' && macroTrend.strength >= 50) {
      // Strong bearish trend - block BUY
      if (macroTrend.direction === 'BEARISH' && decision === 'BUY') {
        logger.warn(`⛔ [${symbol}] MACRO TREND BEARISH (${macroTrend.strength.toFixed(0)}%) - BUY BLOCKED`, {
          priceChange1h: `${macroTrend.priceChange1h.toFixed(2)}%`,
          priceChange4h: `${macroTrend.priceChange4h.toFixed(2)}%`,
        });
        return {
          decision: 'HOLD',
          confidence: 0,
          reasoning: `⛔ MACRO TREND BEARISH (${macroTrend.strength.toFixed(0)}%) - Non comprare in downtrend (1h: ${macroTrend.priceChange1h.toFixed(2)}%, 4h: ${macroTrend.priceChange4h.toFixed(2)}%)`,
          orderBookData: analysis,
          regime: config.regime,
        };
      }
      
      // Strong bullish trend - block SELL
      if (macroTrend.direction === 'BULLISH' && decision === 'SELL') {
        logger.warn(`⛔ [${symbol}] MACRO TREND BULLISH (${macroTrend.strength.toFixed(0)}%) - SELL BLOCKED`, {
          priceChange1h: `${macroTrend.priceChange1h.toFixed(2)}%`,
          priceChange4h: `${macroTrend.priceChange4h.toFixed(2)}%`,
        });
        return {
          decision: 'HOLD',
          confidence: 0,
          reasoning: `⛔ MACRO TREND BULLISH (${macroTrend.strength.toFixed(0)}%) - Non shortare in uptrend (1h: ${macroTrend.priceChange1h.toFixed(2)}%, 4h: ${macroTrend.priceChange4h.toFixed(2)}%)`,
          orderBookData: analysis,
          regime: config.regime,
        };
      }

      // Trend allineato - bonus confluenza
      if ((macroTrend.direction === 'BULLISH' && decision === 'BUY') ||
          (macroTrend.direction === 'BEARISH' && decision === 'SELL')) {
        confluences++;
        confluenceDetails.push(`✅ Macro Trend: ${macroTrend.direction} (${macroTrend.strength.toFixed(0)}%)`);
        confidence += 0.05;
        reasons.push(`📈 TREND ALIGNED`);
      }
    }

    // ========================================
    // WAVE SURFING - LIQUIDITY TRACKER INTEGRATION
    // Usa i dati del liquidity tracker per timing migliore
    // ========================================
    if (decision !== 'HOLD') {
      try {
        const snapshot = liquidityTracker.getCurrentSnapshot();
        if (snapshot) {
          // Verifica allineamento con wave direction
          const waveAligned = 
            (decision === 'BUY' && snapshot.waveDirection === 'UP') ||
            (decision === 'SELL' && snapshot.waveDirection === 'DOWN');
          
          const waveOpposed = 
            (decision === 'BUY' && snapshot.waveDirection === 'DOWN') ||
            (decision === 'SELL' && snapshot.waveDirection === 'UP');
          
          if (waveAligned && snapshot.waveStrength > 40) {
            confluences++;
            confluenceDetails.push(`🏄 Wave ${snapshot.waveDirection} (${snapshot.waveStrength.toFixed(0)}%)`);
            confidence += snapshot.waveStrength / 500; // Max +0.20 bonus
            reasons.push(`🏄 SURFING WAVE ${snapshot.waveDirection}`);
            
            logger.info(`🏄 [${symbol}] Wave confirms ${decision}`, {
              waveDirection: snapshot.waveDirection,
              waveStrength: snapshot.waveStrength,
            });
          } else if (waveOpposed && snapshot.waveStrength > 60) {
            // Wave forte in direzione opposta - riduce confidence
            confidence *= 0.8;
            reasons.push(`⚠️ Wave opposta (${snapshot.waveDirection})`);
            
            logger.warn(`⚠️ [${symbol}] Wave opposed to ${decision}`, {
              waveDirection: snapshot.waveDirection,
              waveStrength: snapshot.waveStrength,
            });
          }
          
          // Controlla spoofing - se ci sono alert recenti vicini al prezzo attuale, cautela
          const recentSpoofing = snapshot.spoofingAlerts?.filter(a => 
            Date.now() - a.timestamp < 10000 && a.confidence > 70
          ) || [];
          
          if (recentSpoofing.length > 0) {
            confidence *= 0.85;
            reasons.push(`🚨 Spoofing alert attivo`);
            logger.warn(`🚨 [${symbol}] Spoofing detected - reducing confidence`);
          }
        }
      } catch (error) {
        // Liquidity tracker not available, continue without it
        logger.debug(`[${symbol}] Liquidity tracker not available`);
      }
    }

    // ========================================
    // VERIFICA CONFLUENZE MINIME
    // ========================================
    if (decision !== 'HOLD' && confluences < STATIC_CONFIG.MIN_CONFLUENCES_FOR_TRADE) {
      logger.info(`⚠️ [${symbol}] Solo ${confluences}/${STATIC_CONFIG.MIN_CONFLUENCES_FOR_TRADE} confluenze - NO TRADE`, {
        confluenceCount: confluences,
        details: confluenceDetails.join(', '),
      });
      return {
        decision: 'HOLD',
        confidence: 0,
        reasoning: `⚠️ Solo ${confluences}/${STATIC_CONFIG.MIN_CONFLUENCES_FOR_TRADE} confluenze: ${confluenceDetails.join(', ')}`,
        orderBookData: analysis,
        regime: config.regime,
      };
    }

    // Cap confidence at 0.95
    confidence = Math.min(0.95, confidence);

    // ========================================
    // FILTRO FINALE - CONFIDENCE MINIMA ELITE
    // ========================================
    if (decision !== 'HOLD' && confidence < config.minConfidence) {
      logger.info(`⚠️ [${symbol}] Confidence troppo bassa: ${(confidence * 100).toFixed(0)}% < ${(config.minConfidence * 100).toFixed(0)}%`);
      reasons.push(`❌ Confidence insufficiente`);
      decision = 'HOLD';
      confidence = 0;
    }

    const reasoning = reasons.join(' | ');

    // Log dettagliato per trade validi
    if (decision !== 'HOLD') {
      logger.info(`🎯 [${symbol}] SETUP A+ TROVATO: ${decision}`, {
        confidencePercent: `${(confidence * 100).toFixed(0)}%`,
        confluenceCount: `${confluences}/${STATIC_CONFIG.MIN_CONFLUENCES_FOR_TRADE}+`,
        details: confluenceDetails.join(', '),
        regime: config.regime,
        marketState: analysis.marketState,
      });
    } else {
      logger.debug(`📊 [${symbol}] No trade: ${reasoning.substring(0, 80)}`);
    }

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
