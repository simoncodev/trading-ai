import { logger } from './logger';
import { scheduler } from './scheduler';
import { marketDataService } from '../services/marketDataService';
import { hyperliquidService } from '../services/hyperliquidService';
import { indicatorService } from '../strategies/indicators';
import { aiEngine } from '../ai/aiEngine';
import { config } from '../utils/config';
import { TradeDecision, TradeResult, AIPromptContext, Position } from '../types';
import { FILE_PATHS } from '../utils/constants';
import fs from 'fs/promises';
import path from 'path';
import dbService from '../database/dbService';
import { orderBookAnalyzer } from '../services/orderBookAnalyzer';
import { generateOrderBookSignal } from '../strategies/orderBookStrategy';
import { liquidityHunterStrategy } from '../strategies/liquidityHunterStrategy';
import { liquidityTracker } from '../services/liquidityTracker';
import { multiSymbolTracker } from '../services/multiSymbolLiquidityTracker';
import { 
  applyMasterFilter, 
  checkSignalAlignment, 
  recordLoss, 
  recordWin,
  recordTradeExecuted 
} from '../filters/tradingFilters';
import { WebServer } from '../web/server';

// ============================================
// SIGNAL STABILITY & ANTI-WHIPSAW SYSTEM
// ============================================
interface SignalHistoryEntry {
  timestamp: number;
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  symbol: string;
}

interface PositionReversalTracker {
  lastReversalTime: number;
  reversalCount: number;  // Count in last hour
}

// CONFIGURATION - Anti-Whipsaw (DISABILITATO per Wave Surfing)
const SIGNAL_STABILITY_CONFIG = {
  // Quanti segnali consecutivi nella stessa direzione servono per confermare
  MIN_CONSECUTIVE_SIGNALS: 1,  // 🏄 Wave surfing: 1 segnale basta
  // Finestra temporale per contare i segnali (ms)
  SIGNAL_WINDOW_MS: 30000,  // 30 secondi
  // Cooldown dopo un'inversione prima di permettere un'altra (ms)
  REVERSAL_COOLDOWN_MS: 0,  // 🏄 Wave surfing: nessun cooldown
  // Max inversioni per ora prima di fermarsi
  MAX_REVERSALS_PER_HOUR: 999,  // 🏄 Wave surfing: illimitato
  // Quick exit: chiudi posizione se segnale opposto per N cicli
  QUICK_EXIT_SIGNALS: 1,  // 🏄 Wave surfing: chiudi subito al primo segnale opposto
  // Confidence minima per quick exit
  QUICK_EXIT_MIN_CONFIDENCE: 0.60,  // 🏄 Wave surfing: soglia bassa
};

// Strategy mode from environment variable
// - 'WAVE_SURFING_ONLY': Pure wave surfing based on liquidityTracker + spikeAnalyzer (RECOMMENDED)
// - 'ORDER_BOOK_ONLY': Pure algorithmic (no AI)
// - 'AI_ONLY': Pure AI decisions
// - 'HYBRID': Order book signal + AI confirmation
type StrategyMode = 'WAVE_SURFING_ONLY' | 'ORDER_BOOK_ONLY' | 'AI_ONLY' | 'HYBRID';
const STRATEGY_MODE: StrategyMode = (process.env.STRATEGY_MODE as StrategyMode) || 'WAVE_SURFING_ONLY';

// CONTRARIAN MODE: Invert all signals (BUY becomes SELL, SELL becomes BUY)
// Enable this if the bot consistently loses - it means the signals are correct but inverted
const CONTRARIAN_MODE = process.env.CONTRARIAN_MODE === 'true';

/**
 * Invert a trading decision
 */
function invertDecision(decision: 'BUY' | 'SELL' | 'HOLD'): 'BUY' | 'SELL' | 'HOLD' {
  if (decision === 'BUY') return 'SELL';
  if (decision === 'SELL') return 'BUY';
  return 'HOLD';
}

/**
 * Main trading loop that orchestrates the bot's execution
 */
class TradeLoop {
  private isRunning = false;
  private tradeHistory: TradeDecision[] = [];
  private dailyTradeCount = 0;
  private dailyPnL = 0;
  private lastResetDate = new Date().toDateString();
  
  // ============================================
  // SIGNAL STABILITY TRACKING
  // ============================================
  private signalHistory: Map<string, SignalHistoryEntry[]> = new Map();
  private reversalTrackers: Map<string, PositionReversalTracker> = new Map();

  /**
   * Records a signal for stability tracking
   */
  private recordSignal(symbol: string, decision: 'BUY' | 'SELL' | 'HOLD', confidence: number): void {
    const now = Date.now();
    const entry: SignalHistoryEntry = { timestamp: now, decision, confidence, symbol };
    
    if (!this.signalHistory.has(symbol)) {
      this.signalHistory.set(symbol, []);
    }
    
    const history = this.signalHistory.get(symbol)!;
    history.push(entry);
    
    // Keep only signals within the window
    const cutoff = now - SIGNAL_STABILITY_CONFIG.SIGNAL_WINDOW_MS;
    this.signalHistory.set(symbol, history.filter(h => h.timestamp > cutoff));
  }

  /**
   * Checks if a signal is stable (consistent direction)
   */
  private isSignalStable(symbol: string, decision: 'BUY' | 'SELL'): boolean {
    const history = this.signalHistory.get(symbol) || [];
    
    if (history.length < SIGNAL_STABILITY_CONFIG.MIN_CONSECUTIVE_SIGNALS) {
      return false;
    }
    
    // Check last N signals are in the same direction
    const recentSignals = history.slice(-SIGNAL_STABILITY_CONFIG.MIN_CONSECUTIVE_SIGNALS);
    const allSameDirection = recentSignals.every(s => s.decision === decision);
    
    return allSameDirection;
  }

  /**
   * Checks if we should quick-exit a position due to opposing signals
   */
  private shouldQuickExit(symbol: string, currentPosition: { side: string }): { shouldExit: boolean; reason: string } {
    const history = this.signalHistory.get(symbol) || [];
    
    if (history.length < SIGNAL_STABILITY_CONFIG.QUICK_EXIT_SIGNALS) {
      return { shouldExit: false, reason: '' };
    }
    
    const recentSignals = history.slice(-SIGNAL_STABILITY_CONFIG.QUICK_EXIT_SIGNALS);
    const positionSide = currentPosition.side === 'buy' ? 'BUY' : 'SELL';
    const oppositeSignal = positionSide === 'BUY' ? 'SELL' : 'BUY';
    
    // Check if all recent signals are opposite AND have good confidence
    const allOpposite = recentSignals.every(s => 
      s.decision === oppositeSignal && 
      s.confidence >= SIGNAL_STABILITY_CONFIG.QUICK_EXIT_MIN_CONFIDENCE
    );
    
    if (allOpposite) {
      const avgConfidence = recentSignals.reduce((sum, s) => sum + s.confidence, 0) / recentSignals.length;
      return {
        shouldExit: true,
        reason: `🚨 QUICK EXIT: ${SIGNAL_STABILITY_CONFIG.QUICK_EXIT_SIGNALS} consecutive ${oppositeSignal} signals (avg conf: ${(avgConfidence * 100).toFixed(0)}%)`
      };
    }
    
    return { shouldExit: false, reason: '' };
  }

  /**
   * Checks if reversal is allowed (cooldown check)
   */
  private isReversalAllowed(symbol: string): { allowed: boolean; reason: string } {
    const tracker = this.reversalTrackers.get(symbol);
    const now = Date.now();
    
    if (!tracker) {
      return { allowed: true, reason: '' };
    }
    
    // Check cooldown
    const timeSinceLastReversal = now - tracker.lastReversalTime;
    if (timeSinceLastReversal < SIGNAL_STABILITY_CONFIG.REVERSAL_COOLDOWN_MS) {
      const remainingCooldown = Math.ceil((SIGNAL_STABILITY_CONFIG.REVERSAL_COOLDOWN_MS - timeSinceLastReversal) / 1000);
      return {
        allowed: false,
        reason: `⏳ Reversal cooldown: ${remainingCooldown}s remaining`
      };
    }
    
    // Check max reversals per hour
    if (tracker.reversalCount >= SIGNAL_STABILITY_CONFIG.MAX_REVERSALS_PER_HOUR) {
      return {
        allowed: false,
        reason: `🛑 Max reversals reached (${tracker.reversalCount}/${SIGNAL_STABILITY_CONFIG.MAX_REVERSALS_PER_HOUR} this hour)`
      };
    }
    
    return { allowed: true, reason: '' };
  }

  /**
   * Records a position reversal
   */
  private recordReversal(symbol: string): void {
    const now = Date.now();
    const hourAgo = now - 3600000;
    
    let tracker = this.reversalTrackers.get(symbol);
    
    if (!tracker || tracker.lastReversalTime < hourAgo) {
      // Reset if last reversal was more than an hour ago
      tracker = { lastReversalTime: now, reversalCount: 1 };
    } else {
      tracker.lastReversalTime = now;
      tracker.reversalCount++;
    }
    
    this.reversalTrackers.set(symbol, tracker);
    
    logger.warn(`📊 [${symbol}] Reversal recorded (${tracker.reversalCount}/${SIGNAL_STABILITY_CONFIG.MAX_REVERSALS_PER_HOUR} this hour)`);
  }

  /**
   * Starts the trading loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading loop is already running');
      return;
    }

    logger.info('🚀 Starting Trading AI Agent', {
      symbols: config.trading.symbols.join(', '),
      symbolCount: config.trading.symbols.length,
      interval: config.trading.tradeInterval,
      dryRun: config.system.dryRun,
      liveTrading: config.system.enableLiveTrading,
    });

    this.isRunning = true;

    // Load existing trade history
    await this.loadTradeHistory();

    // Schedule periodic trading task
    if (config.system.enableScheduler) {
      scheduler.scheduleTask(
        'trading-loop',
        config.trading.tradeInterval,
        async () => { await this.executeTradingCycle(); }
      );
      scheduler.start();
    } else {
      // Run once immediately
      await this.executeTradingCycle();
    }
  }

  /**
   * Stops the trading loop
   */
  stop(): void {
    logger.info('⏹️  Stopping Trading AI Agent');
    this.isRunning = false;
    scheduler.stop();
  }

  /**
   * Executes a single trading cycle
   */
  async executeTradingCycle(): Promise<TradeResult | null> {
    try {
      // Reset daily counters if new day
      this.resetDailyCountersIfNeeded();

      // Check daily limits
      if (!this.canTrade()) {
        logger.warn('Daily trading limits reached', {
          dailyTrades: this.dailyTradeCount,
          maxDailyTrades: config.risk.maxDailyTrades,
          dailyPnL: this.dailyPnL,
          maxDailyLoss: config.risk.maxDailyLoss,
        });
        return null;
      }

      // Execute trading cycle for all symbols in parallel
      const symbols = config.trading.symbols;
      logger.info(`📊 Executing trading cycle for ${symbols.length} symbols: ${symbols.join(', ')}`);

      const results = await Promise.allSettled(
        symbols.map(symbol => this.executeTradingCycleForSymbol(symbol))
      );

      // Log results
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      logger.info(`Trading cycle completed: ${successful} successful, ${failed} failed`);

      return null;
    } catch (error: any) {
      logger.error('Error in trading cycle', { error: error.message });
      return null;
    }
  }

  /**
   * Executes trading cycle for a single symbol
   */
  private async executeTradingCycleForSymbol(symbol: string): Promise<TradeResult | null> {
    try {
      logger.info(`📊 Analyzing ${symbol}`);

      // Step 1: Fetch market data
      const marketSnapshot = await marketDataService.getMarketSnapshot(
        symbol,
        config.trading.tradeInterval
      );

      logger.debug('Market snapshot retrieved', {
        currentPrice: marketSnapshot.currentPrice,
        volume24h: marketSnapshot.volume24h,
        volatility: marketSnapshot.volatility,
      });

      // Step 2: Calculate indicators (standard + multi-timeframe)
      const candles = marketSnapshot.recentCandles;
      const indicators = await indicatorService.getIndicators(candles);
      const multiTfIndicators = await indicatorService.getMultiTimeframeIndicators(candles, marketSnapshot.currentPrice);

      logger.info('Technical indicators calculated', {
        rsi: indicators.rsi.toFixed(2),
        emaTrend: indicatorService.getEMATrend(indicators),
        macdHistogram: indicators.macd.histogram.toFixed(4),
        rsiShort: multiTfIndicators.rsi.short.toFixed(2),
        rsiMedium: multiTfIndicators.rsi.medium.toFixed(2),
      });

      // Step 3: Get account info
      const account = await hyperliquidService.getAccount();
      const currentPosition = account.positions.find((p: Position) => p.symbol === symbol);

      logger.debug('Account status', {
        balance: account.balance,
        availableBalance: account.availableBalance,
        positionCount: account.positions.length,
      });

      // Step 3.5: Verifica posizioni aperte nel database
      const allActivePositions = await dbService.getActiveTrades();
      const existingDbPosition = allActivePositions.find(t => t.symbol === symbol);

      // Step 3.6: Calcola P&L non realizzato totale
      let totalUnrealizedPnl = 0;
      for (const pos of allActivePositions) {
        const currentPosPrice = await hyperliquidService.getTickerPrice(pos.symbol);
        const priceDiff = pos.side === 'buy' 
          ? currentPosPrice - pos.entry_price 
          : pos.entry_price - currentPosPrice;
        const posLeverage = pos.leverage || 1;
        const posUnrealizedPnl = priceDiff * pos.quantity * posLeverage;
        totalUnrealizedPnl += posUnrealizedPnl;
      }
      const startingBalance = Number(process.env.STARTING_BALANCE) || 100;
      const unrealizedPnlPercentage = (totalUnrealizedPnl / startingBalance) * 100;

      // Step 3.7: Get trading statistics for AI context
      const tradeStats = await dbService.getTradeStats();
      logger.debug('Trade statistics loaded', {
        totalTrades: tradeStats.totalTrades,
        winRate: tradeStats.winRate.toFixed(1) + '%',
        recentWinRate: tradeStats.recentWinRate.toFixed(1) + '%',
        consecutiveLosses: tradeStats.consecutiveLosses,
      });

      // Step 3.8: Analyze order book
      const orderBookData = await orderBookAnalyzer.analyzeOrderBook(symbol);
      if (orderBookData) {
        logger.info('📊 Order Book Analysis', {
          imbalance: `${(orderBookData.imbalanceRatio * 100).toFixed(1)}%`,
          signal: orderBookData.imbalanceSignal,
          orderBookSignal: orderBookData.orderBookSignal.toFixed(3),
          orderBookConfidence: `${(orderBookData.confidence * 100).toFixed(0)}%`,
          spread: `${orderBookData.spread.toFixed(4)}%`,
          liquidity: orderBookData.liquidityScore,
        });
      }

      // Step 4: Prepare AI context
      const aiContext: AIPromptContext = {
        symbol,
        currentPrice: marketSnapshot.currentPrice,
        indicators,
        multiTfIndicators, // NEW: Multi-timeframe indicators
        recentCandles: candles.slice(-10),
        accountBalance: account.availableBalance,
        currentPosition,
        marketCondition: this.determineMarketCondition(marketSnapshot, indicators),
        timestamp: Date.now(),
        openPositions: allActivePositions,
        hasOpenPosition: !!existingDbPosition,
        existingPosition: existingDbPosition || null,
        unrealizedPnl: totalUnrealizedPnl,
        unrealizedPnlPercentage,
        orderBookAnalysis: orderBookData ? {
          imbalanceRatio: orderBookData.imbalanceRatio,
          imbalanceSignal: orderBookData.imbalanceSignal,
          spread: orderBookData.spread,
          liquidityScore: orderBookData.liquidityScore,
          orderBookSignal: orderBookData.orderBookSignal,
          confidence: orderBookData.confidence,
          bidPressure: orderBookData.bidPressure,
          askPressure: orderBookData.askPressure,
          nearestBidWall: orderBookData.nearestBidWall ? {
            price: orderBookData.nearestBidWall.price,
            size: orderBookData.nearestBidWall.size,
            distancePercent: orderBookData.nearestBidWall.distancePercent,
          } : undefined,
          nearestAskWall: orderBookData.nearestAskWall ? {
            price: orderBookData.nearestAskWall.price,
            size: orderBookData.nearestAskWall.size,
            distancePercent: orderBookData.nearestAskWall.distancePercent,
          } : undefined,
        } : undefined,
        tradeStats: {
          totalTrades: tradeStats.totalTrades,
          winRate: tradeStats.winRate,
          recentWinRate: tradeStats.recentWinRate,
          profitFactor: tradeStats.profitFactor,
          consecutiveLosses: tradeStats.consecutiveLosses,
          averageWin: tradeStats.averageWin,
          averageLoss: tradeStats.averageLoss,
        },
      };

      // Step 4.5: Apply Master Trading Filters
      const masterFilter = applyMasterFilter(
        indicators,
        multiTfIndicators,
        marketSnapshot.currentPrice,
        0.6, // Preliminary confidence estimate
        tradeStats.consecutiveLosses
      );

      // Log filter results
      logger.info('🔍 Trading filters applied', {
        canTrade: masterFilter.canTrade,
        sizeMultiplier: masterFilter.finalSizeMultiplier.toFixed(2),
        adjustedThreshold: masterFilter.adjustedConfidenceThreshold,
        session: masterFilter.filters.session.name,
        trendStrength: masterFilter.filters.volatility.trendStrength,
      });

      // If filters block trading, skip this cycle
      if (!masterFilter.canTrade) {
        const blockReasons = masterFilter.reasons.filter(r => r.startsWith('❌')).join('; ');
        logger.warn(`⛔ Trading blocked by filters for ${symbol}`, {
          reasons: blockReasons,
        });
        
        // Save the decision as blocked
        const blockedDecision: TradeDecision = {
          timestamp: Date.now(),
          symbol,
          decision: 'HOLD',
          confidence: 0,
          reasoning: `Blocked by filters: ${masterFilter.reasons.filter(r => r.startsWith('❌')).join('; ')}`,
          currentPrice: marketSnapshot.currentPrice,
          indicators,
          executed: false,
          error: 'Blocked by trading filters',
        };
        await this.saveTradeDecision(blockedDecision);
        return null;
      }

      // Step 5: Get trading decision based on strategy mode
      let decision: 'BUY' | 'SELL' | 'HOLD';
      let confidence: number;
      let reasoning: string;
      let obSignal: Awaited<ReturnType<typeof generateOrderBookSignal>> | null = null;

      if (STRATEGY_MODE === 'WAVE_SURFING_ONLY') {
        // 🏄 WAVE SURFING STRATEGY
        // Apri IMMEDIATAMENTE al segnale, chiudi al segnale opposto
        logger.info('🏄 Using WAVE SURFING strategy...');
        
        // Usa multiSymbolTracker per il simbolo corrente
        const antiSpoofSignal = multiSymbolTracker.getAntiSpoofingSignal(symbol);
        
        // Log sempre lo stato dello spoofing
        logger.info(`🔍 [${symbol}] Spoofing Analysis`, {
          action: antiSpoofSignal.action,
          confidence: antiSpoofSignal.confidence,
          askSpoof: `${antiSpoofSignal.details.askSpoofCount} alerts, ${antiSpoofSignal.details.askSpoofVolume.toFixed(2)} units`,
          bidSpoof: `${antiSpoofSignal.details.bidSpoofCount} alerts, ${antiSpoofSignal.details.bidSpoofVolume.toFixed(2)} units`,
          dominantRatio: `${(antiSpoofSignal.details.spoofRatio * 100).toFixed(0)}%`,
        });
        
        // 🏄 WAVE SURFING: Soglie aggressive per reattività
        // 50% confidence e 52% dominanza per entrare subito
        const MIN_CONFIDENCE = 50;
        const MIN_RATIO = 0.52;
        
        if (antiSpoofSignal.action !== 'WAIT' && 
            antiSpoofSignal.confidence >= MIN_CONFIDENCE && 
            antiSpoofSignal.details.spoofRatio >= MIN_RATIO) {
          
          decision = antiSpoofSignal.action;
          confidence = antiSpoofSignal.confidence / 100;
          reasoning = `🏄 [WAVE SURF] ${antiSpoofSignal.reasoning}`;
          
          logger.info(`🏄 [${symbol}] WAVE SURF SIGNAL`, {
            action: antiSpoofSignal.action,
            confidence: antiSpoofSignal.confidence,
            spoofRatio: `${(antiSpoofSignal.details.spoofRatio * 100).toFixed(0)}%`,
          });
          
        } else {
          // Nessun segnale valido - HOLD
          decision = 'HOLD';
          confidence = 0;
          reasoning = antiSpoofSignal.action === 'WAIT' 
            ? `Spoofing insufficiente (${antiSpoofSignal.details.highConfidenceAlerts} alerts)`
            : `Sotto soglia (conf: ${antiSpoofSignal.confidence}%, ratio: ${(antiSpoofSignal.details.spoofRatio * 100).toFixed(0)}%)`;
        }

        logger.info(`🏄 [${symbol}] Wave Surf Decision: ${decision}`, {
          decision,
          confidencePercent: `${(confidence * 100).toFixed(0)}%`,
          reasoning: reasoning.substring(0, 150),
        });

      } else if (STRATEGY_MODE === 'ORDER_BOOK_ONLY') {
        // ORDER BOOK PURE STRATEGY
        logger.info('📊 Using ORDER BOOK ONLY strategy...');
        obSignal = await generateOrderBookSignal(symbol);
        
        if (!obSignal) {
          logger.warn(`No order book signal for ${symbol}`);
          return null;
        }

        decision = obSignal.decision;
        confidence = obSignal.confidence;
        reasoning = obSignal.reasoning;

        // ⚠️ TREND FILTER: Block counter-trend trades
        // Trade WITH the trend for higher probability
        const emaTrend = indicatorService.getEMATrend(indicators);
        
        // TREND RULES (10x leverage - più conservativo):
        // - BUY: OK in bullish, OK in neutral con alta confidence
        // - SELL: OK in bearish, OK in neutral con alta confidence
        // - Counter-trend: BLOCKED sempre
        const isCounterTrend = 
          (decision === 'BUY' && emaTrend === 'bearish') ||
          (decision === 'SELL' && emaTrend === 'bullish');
        
        // Neutral trend: richiede confidence più alta (75%)
        const isNeutralHighRisk = 
          emaTrend === 'neutral' && confidence < 0.75;
        
        if (isCounterTrend && decision !== 'HOLD') {
          logger.warn(`🚫 COUNTER-TREND BLOCKED: ${decision} blocked because EMA trend is ${emaTrend}`, {
            obDecision: decision,
            emaTrend,
            confidencePercent: `${(confidence * 100).toFixed(0)}%`,
          });
          // BLOCK the trade completely
          decision = 'HOLD';
          confidence = 0;
          reasoning = `[BLOCKED - COUNTER-TREND] ${decision} not allowed in ${emaTrend} trend`;
        } else if (isNeutralHighRisk && decision !== 'HOLD') {
          logger.warn(`🚫 NEUTRAL-LOW-CONF BLOCKED: ${decision} needs 75%+ confidence in neutral trend`, {
            obDecision: decision,
            emaTrend,
            confidencePercent: `${(confidence * 100).toFixed(0)}%`,
          });
          decision = 'HOLD';
          confidence = 0;
          reasoning = `[BLOCKED - NEUTRAL LOW CONF] Needs 75%+ in neutral trend`;
        } else if (decision !== 'HOLD') {
          // Trend alignment bonus
          const trendBonus = emaTrend !== 'neutral' ? 1.15 : 1.05;
          confidence = Math.min(0.95, confidence * trendBonus);
          reasoning = `[TREND-ALIGNED ✅] ${reasoning}`;
          logger.info(`✅ TREND-ALIGNED: ${decision} confirmed by ${emaTrend} trend`);
        }

        // 🎯 LIQUIDITY HUNTER CONFIRMATION
        // Verifica che la direzione sia supportata dalla liquidity map
        if (decision !== 'HOLD') {
          const liqConfirmation = await liquidityHunterStrategy.getConfirmation(symbol, decision);
          
          // 🏄 WAVE SURFING - usa il liquidityTracker in tempo reale
          const surfRec = liquidityTracker.getSurfRecommendation();
          const waveAligned = surfRec.action === decision || surfRec.action === 'WAIT';
          
          logger.info(`🎯 Liquidity Hunter: ${liqConfirmation.confirmed ? 'CONFIRMS' : 'REJECTS'}`, {
            confirmed: liqConfirmation.confirmed,
            liquidityConfidence: `${(liqConfirmation.confidence * 100).toFixed(0)}%`,
            reasoning: liqConfirmation.reasoning,
          });
          
          logger.info(`🏄 Wave Surfing: ${surfRec.action}`, {
            waveAligned,
            surfConfidence: `${surfRec.confidence.toFixed(0)}%`,
            surfReasoning: surfRec.reasoning,
          });
          
          if (liqConfirmation.confirmed && waveAligned) {
            // Doppia conferma: liquidity hunter + wave surfing
            confidence = Math.min(0.95, confidence + liqConfirmation.confidence * 0.15 + surfRec.confidence * 0.001);
            reasoning = `${reasoning} | 🎯 ${liqConfirmation.reasoning} | 🏄 Wave: ${surfRec.action}`;
            logger.info(`✅ DOPPIA CONFERMA: LiquidityHunter + WaveSurfing`);
          } else if (liqConfirmation.confirmed) {
            // Solo liquidity hunter conferma
            confidence = Math.min(0.95, confidence + liqConfirmation.confidence * 0.10);
            reasoning = `${reasoning} | 🎯 ${liqConfirmation.reasoning}`;
          } else if (waveAligned && surfRec.confidence > 50) {
            // Solo wave surfing conferma ma forte
            confidence = Math.min(0.95, confidence + surfRec.confidence * 0.001);
            reasoning = `${reasoning} | 🏄 Wave: ${surfRec.action} (${surfRec.confidence.toFixed(0)}%)`;
          } else if (liqConfirmation.confidence < 0.3 || (!waveAligned && surfRec.confidence > 60)) {
            // Liquidity fortemente contraria O wave contraria forte - riduce confidence
            confidence *= 0.75;
            reasoning = `${reasoning} | ⚠️ Liquidity/Wave contrario`;
            logger.warn(`⚠️ Liquidity/Wave contrario - confidence ridotta`, {
              newConfidence: `${(confidence * 100).toFixed(0)}%`,
              waveAction: surfRec.action,
              waveConfidence: surfRec.confidence,
            });
          }
        }

        logger.info(`📊 Order Book Decision: ${decision}`, {
          decision,
          confidencePercent: `${(confidence * 100).toFixed(0)}%`,
          emaTrend,
          reasoning: reasoning.substring(0, 100),
        });

      } else if (STRATEGY_MODE === 'AI_ONLY') {
        // AI STRATEGY (original)
        logger.info('🤖 Using AI ONLY strategy...');
        const aiResponse = await aiEngine.generateDecisionWithRetry(aiContext);
        decision = aiResponse.decision;
        confidence = aiResponse.confidence;
        reasoning = aiResponse.reasoning;

        logger.info(`🤖 AI Decision: ${decision}`, {
          decision,
          confidence,
          reasoning: reasoning.substring(0, 100) + '...',
        });

      } else {
        // HYBRID MODE: Order Book signal + AI confirmation
        logger.info('🔀 Using HYBRID strategy (Order Book + AI)...');
        
        // Step 5a: Get order book signal first
        obSignal = await generateOrderBookSignal(symbol);
        
        if (!obSignal || obSignal.decision === 'HOLD') {
          logger.info(`📊 Order Book says HOLD - skipping AI call`);
          return null;
        }

        const obDecision = obSignal.decision;
        const obConfidence = obSignal.confidence;
        const obReasoning = obSignal.reasoning;

        logger.info(`📊 Order Book Signal: ${obDecision}`, {
          decision: obDecision,
          confidencePercent: `${(obConfidence * 100).toFixed(0)}%`,
          regime: obSignal.regime,
        });

        // Step 5b: Ask AI to confirm/reject the order book signal
        const hybridContext: AIPromptContext = {
          ...aiContext,
          additionalContext: `
⚠️ IMPORTANT - HYBRID MODE CONFIRMATION REQUEST ⚠️

The ORDER BOOK has detected a ${obDecision} signal with ${(obConfidence * 100).toFixed(0)}% confidence.
Reasoning: ${obReasoning}
Market Regime: ${obSignal.regime || 'UNKNOWN'}

YOUR TASK: You MUST respond with either ${obDecision} (to confirm) or HOLD (to reject).
- Respond "${obDecision}" if technical indicators support this direction
- Respond "HOLD" ONLY if indicators clearly contradict the signal

DO NOT be overly conservative. If indicators are neutral/mixed, CONFIRM the order book signal.
The order book sees real-time market pressure that you cannot see from lagging indicators.

Remember: We need trades to make profits. Only reject clear counter-signals.
`,
        };

        logger.info('🤖 Asking AI to confirm Order Book signal...');
        const aiResponse = await aiEngine.generateDecisionWithRetry(hybridContext);
        
        // AI confirms if it agrees with order book direction
        const aiConfirms = aiResponse.decision === obDecision;
        
        logger.info(`🤖 AI Response: ${aiResponse.decision}`, {
          aiDecision: aiResponse.decision,
          aiConfidence: aiResponse.confidence,
          confirms: aiConfirms,
        });

        if (aiConfirms) {
          // Both agree - combine confidence
          decision = obDecision;
          // Weighted average: 60% order book, 40% AI
          confidence = (obConfidence * 0.6) + (aiResponse.confidence * 0.4);
          reasoning = `[HYBRID CONFIRMED] OB: ${obReasoning.substring(0, 80)} | AI: ${aiResponse.reasoning.substring(0, 80)}`;
          
          logger.info(`✅ HYBRID AGREEMENT: ${decision}`, {
            combinedConfidence: `${(confidence * 100).toFixed(0)}%`,
            obConfidence: `${(obConfidence * 100).toFixed(0)}%`,
            aiConfidence: `${(aiResponse.confidence * 100).toFixed(0)}%`,
          });
        } else {
          // Disagreement - HOLD
          decision = 'HOLD';
          confidence = 0;
          reasoning = `[HYBRID REJECTED] OB wanted ${obDecision}, AI wanted ${aiResponse.decision}`;
          
          logger.warn(`❌ HYBRID DISAGREEMENT - HOLD`, {
            obWanted: obDecision,
            aiWanted: aiResponse.decision,
          });
        }
      }

      // CONTRARIAN MODE: Invert the signal if enabled
      if (CONTRARIAN_MODE && decision !== 'HOLD') {
        const originalDecision = decision;
        decision = invertDecision(decision);
        logger.warn(`🔄 CONTRARIAN MODE: ${originalDecision} → ${decision}`, {
          originalDecision,
          invertedDecision: decision,
          reasoning: 'Signals are inverted based on historical performance analysis',
        });
        reasoning = `[CONTRARIAN] Original: ${originalDecision} - ${reasoning}`;
      }

      // Step 5.5: Re-apply filter with actual confidence and check signal alignment
      const finalFilter = applyMasterFilter(
        indicators,
        multiTfIndicators,
        marketSnapshot.currentPrice,
        confidence,
        tradeStats.consecutiveLosses
      );

      // Check if signal aligns with trend (for AI and HYBRID modes)
      if (STRATEGY_MODE !== 'ORDER_BOOK_ONLY') {
        const signalAlignment = checkSignalAlignment(decision, finalFilter.filters.volatility);
        if (!signalAlignment.aligned && finalFilter.filters.volatility.trendStrength >= 60) {
          logger.warn(`⚠️ Counter-trend signal detected`, { 
            signal: decision,
            trend: finalFilter.filters.volatility.trendDirection,
          });
          finalFilter.finalSizeMultiplier *= 0.5;
        }
      }

      // Effective threshold based on strategy mode - USE CONFIG VALUE
      const effectiveThreshold = STRATEGY_MODE === 'ORDER_BOOK_ONLY'
        ? config.trading.confidenceThreshold  // Use config (0.70)
        : STRATEGY_MODE === 'HYBRID'
        ? Math.max(0.60, config.trading.confidenceThreshold)  // HYBRID needs higher confidence
        : Math.max(config.trading.confidenceThreshold, finalFilter.adjustedConfidenceThreshold);

      // Step 6: Create trade decision record
      const tradeDecision: TradeDecision = {
        timestamp: Date.now(),
        symbol,
        decision,
        confidence,
        reasoning,
        currentPrice: marketSnapshot.currentPrice,
        indicators,
        executed: false,
      };

      // ============================================
      // SIGNAL STABILITY CHECK (Anti-Whipsaw)
      // ============================================
      
      // Record this signal for stability tracking
      this.recordSignal(symbol, decision, confidence);
      
      // Step 7: Execute trade if confidence threshold met
      if (confidence >= effectiveThreshold) {
        if (decision === 'BUY' || decision === 'SELL') {
          
          // CHECK 1: Signal Stability - require consistent signals before trading
          if (!this.isSignalStable(symbol, decision)) {
            const history = this.signalHistory.get(symbol) || [];
            logger.warn(`📊 [${symbol}] SIGNAL NOT STABLE YET - Waiting for ${SIGNAL_STABILITY_CONFIG.MIN_CONSECUTIVE_SIGNALS} consecutive ${decision} signals`, {
              currentSignals: history.length,
              recentDecisions: history.slice(-5).map(h => h.decision).join(' → '),
            });
            tradeDecision.executed = false;
            tradeDecision.error = `Signal not stable (need ${SIGNAL_STABILITY_CONFIG.MIN_CONSECUTIVE_SIGNALS} consecutive ${decision})`;
            await this.saveTradeDecision(tradeDecision);
            return null;
          }
          
          logger.info(`✅ [${symbol}] Signal stable: ${SIGNAL_STABILITY_CONFIG.MIN_CONSECUTIVE_SIGNALS}+ consecutive ${decision} signals`);
          
          // CONTROLLO PRIORITARIO: Verifica posizioni dal database (funziona anche in DRY_RUN)
          const allActivePositions = await dbService.getActiveTrades();
          const existingDbPosition = allActivePositions.find(t => t.symbol === symbol);
          
          // ============================================
          // QUICK EXIT CHECK - Close position on confirmed reversal signal
          // ============================================
          if (existingDbPosition) {
            const quickExitCheck = this.shouldQuickExit(symbol, existingDbPosition);
            if (quickExitCheck.shouldExit) {
              logger.warn(`${quickExitCheck.reason}`, { symbol });
              
              // Close position immediately without opening new one
              try {
                const exitPrice = marketSnapshot.currentPrice;
                const entryPrice = parseFloat(existingDbPosition.entry_price);
                const quantity = parseFloat(existingDbPosition.quantity);
                const positionSide = existingDbPosition.side;
                
                let pnl = 0;
                if (positionSide === 'buy') {
                  pnl = (exitPrice - entryPrice) * quantity;
                } else {
                  pnl = (entryPrice - exitPrice) * quantity;
                }
                
                await dbService.updateTrade(existingDbPosition.trade_id, exitPrice, pnl, 'closed');
                
                // Calculate fees
                const entryFee = quantity * entryPrice * 0.00035;
                const exitFee = quantity * exitPrice * 0.00035;
                const totalFees = entryFee + exitFee;
                
                // Update balance with fees
                await dbService.updateBalanceOnTradeClose(pnl, totalFees);

                logger.info(`🚨 QUICK EXIT: Posizione ${positionSide.toUpperCase()} chiusa su ${symbol} - P&L: $${pnl.toFixed(2)}`);
                
                if (pnl > 0) recordWin(); else recordLoss();
                
                // Close on exchange if not DRY_RUN
                if (!config.system.dryRun && currentPosition) {
                  const closeSide = positionSide === 'buy' ? 'sell' : 'buy';
                  await hyperliquidService.placeOrder(symbol, closeSide, currentPosition.size, exitPrice);
                }
                
                // Record reversal but DON'T open new position - wait for next stable signal
                this.recordReversal(symbol);
                tradeDecision.executed = false;
                tradeDecision.error = 'Quick exit executed - waiting for next stable signal';
                await this.saveTradeDecision(tradeDecision);
                return null;
                
              } catch (error) {
                logger.error(`Quick exit failed for ${symbol}`, error);
              }
            }
          }
          
          // ========================================
          // CRYPTO CORRELATION FILTER
          // Tutte le crypto si muovono insieme, trainate da BTC
          // Non aprire posizioni in direzione opposta a quelle esistenti
          // ========================================
          const signalSide = decision === 'BUY' ? 'buy' : 'sell';
          
          // Controlla se ci sono posizioni aperte in direzione opposta
          const oppositePositions = allActivePositions.filter(p => p.side !== signalSide);
          const sameDirectionPositions = allActivePositions.filter(p => p.side === signalSide);
          
          if (oppositePositions.length > 0 && !existingDbPosition) {
            // Abbiamo posizioni in direzione opposta - BLOCCA
            const oppositeSymbols = oppositePositions.map(p => p.symbol).join(', ');
            logger.warn(`🔗 [${symbol}] CRYPTO CORRELATION BLOCK: Segnale ${signalSide.toUpperCase()} bloccato`, {
              reason: 'Posizioni aperte in direzione opposta',
              oppositePositions: oppositeSymbols,
              oppositeSide: oppositePositions[0].side,
              currentSignal: signalSide,
            });
            tradeDecision.executed = false;
            tradeDecision.error = `Crypto correlation: ${oppositePositions[0].side.toUpperCase()} positions open on ${oppositeSymbols}`;
            await this.saveTradeDecision(tradeDecision);
            return null;
          }
          
          // Log direzione coerente
          if (sameDirectionPositions.length > 0) {
            logger.info(`🔗 [${symbol}] CRYPTO CORRELATION OK: Direzione coerente con ${sameDirectionPositions.length} altre posizioni ${signalSide.toUpperCase()}`);
          }
          
          // Gestione posizioni esistenti dal DATABASE
          if (existingDbPosition) {
            const positionSide = existingDbPosition.side; // 'buy' o 'sell'
            const signalSide = decision === 'BUY' ? 'buy' : 'sell';

            // Se segnale uguale a posizione esistente → SKIP
            if (positionSide === signalSide) {
              logger.info(`[${symbol}] POSIZIONE ${signalSide.toUpperCase()} GIÀ APERTA NEL DB - SKIP`, {
                tradeId: existingDbPosition.trade_id,
                side: existingDbPosition.side,
                quantity: existingDbPosition.quantity,
              });
              tradeDecision.executed = false;
              tradeDecision.error = 'Position already exists in same direction (DB check)';
              await this.saveTradeDecision(tradeDecision);
              return null;
            }

            // ============================================
            // REVERSAL COOLDOWN CHECK (Anti-Whipsaw)
            // ============================================
            const reversalCheck = this.isReversalAllowed(symbol);
            if (!reversalCheck.allowed) {
              logger.warn(`🚫 [${symbol}] REVERSAL BLOCKED: ${reversalCheck.reason}`, {
                from: positionSide.toUpperCase(),
                to: signalSide.toUpperCase(),
              });
              tradeDecision.executed = false;
              tradeDecision.error = reversalCheck.reason;
              await this.saveTradeDecision(tradeDecision);
              return null;
            }

            // Se segnale opposto → CHIUDI + APRI NUOVA (inversione)
            logger.info(`[${symbol}] INVERSIONE POSIZIONE DB: ${positionSide.toUpperCase()} → ${signalSide.toUpperCase()}`);

            // 1. Chiudi posizione esistente nel DB
            try {
              const exitPrice = marketSnapshot.currentPrice;
              const entryPrice = parseFloat(existingDbPosition.entry_price);
              const quantity = parseFloat(existingDbPosition.quantity);
              
              // Calcola P&L
              let pnl = 0;
              if (existingDbPosition.side === 'buy') {
                pnl = (exitPrice - entryPrice) * quantity;
              } else {
                pnl = (entryPrice - exitPrice) * quantity;
              }
              
              await dbService.updateTrade(
                existingDbPosition.trade_id,
                exitPrice,
                pnl,
                'closed'
              );
              logger.info(`✅ Posizione DB ${positionSide.toUpperCase()} chiusa su ${symbol} - P&L: $${pnl.toFixed(2)}`);
              
              // Track win/loss for cooldown system
              if (pnl > 0) {
                recordWin();
              } else {
                recordLoss();
              }
              
              // ============================================
              // RECORD REVERSAL (Anti-Whipsaw)
              // ============================================
              this.recordReversal(symbol);
              
              // Se NON in DRY_RUN, chiudi anche su Hyperliquid
              if (!config.system.dryRun && currentPosition) {
                const closeSide = positionSide === 'buy' ? 'sell' : 'buy';
                await hyperliquidService.placeOrder(
                  symbol,
                  closeSide,
                  currentPosition.size,
                  marketSnapshot.currentPrice
                );
                logger.info(`✅ Posizione Hyperliquid ${currentPosition.side.toUpperCase()} chiusa su ${symbol}`);
              }
            } catch (error) {
              logger.error(`Errore chiusura posizione ${symbol}`, error);
              tradeDecision.executed = false;
              tradeDecision.error = 'Failed to close existing position';
              await this.saveTradeDecision(tradeDecision);
              return null;
            }
          } else {
            // Nessuna posizione su questo symbol: controlliamo MAX_POSITIONS
            const maxPositions = config.trading.maxPositions;
            
            if (allActivePositions.length >= maxPositions) {
              logger.warn(`[${symbol}] MAX POSIZIONI RAGGIUNTO (${allActivePositions.length}/${maxPositions}) - SKIP`);
              tradeDecision.executed = false;
              tradeDecision.error = `Max positions limit reached (${allActivePositions.length}/${maxPositions})`;
              await this.saveTradeDecision(tradeDecision);
              return null;
            }
            
            logger.info(`[${symbol}] NUOVA POSIZIONE OK (${allActivePositions.length + 1}/${maxPositions})`);
          }

          // Create response object for executeTrade
          const tradeResponse = { decision, confidence, reasoning };

          // 2. Apri nuova posizione (opposta o se non c'era posizione)
          const result = await this.executeTrade(tradeResponse, marketSnapshot.currentPrice, symbol, finalFilter.finalSizeMultiplier);
          tradeDecision.executed = result.success;
          tradeDecision.orderId = result.order?.orderId;
          tradeDecision.error = result.error;

          if (result.success) {
            this.dailyTradeCount++;
            // ELITE: Record trade for cooldown system
            recordTradeExecuted();
            
            if (result.order) {
              // Update daily P&L estimation (simplified)
              this.dailyPnL += result.order.fee * -1;
              
              // Emit evento WebSocket per aggiornare dashboard in tempo reale
              const webServer = (global as any).webServer;
              if (webServer && typeof webServer.emitNewTrade === 'function') {
                webServer.emitNewTrade({
                  symbol,
                  side: result.order.side,
                  quantity: result.order.quantity,
                  price: result.order.price,
                  timestamp: Date.now()
                });
              }
            }
          }

          // Save trade decision
          await this.saveTradeDecision(tradeDecision);

          return result;
        } else {
          logger.info('Decision: HOLD - No action taken');
        }
      } else {
        logger.warn(`Confidence too low (${confidence.toFixed(2)}), skipping trade`);
      }

      // Save decision even if not executed
      await this.saveTradeDecision(tradeDecision);

      return null;
    } catch (error) {
      logger.error('Error in trading cycle', error);
      return null;
    }
  }

  /**
   * Executes a trade based on AI decision
   */
  private async executeTrade(
    aiResponse: any,
    currentPrice: number,
    symbol: string,
    sizeMultiplier: number = 1.0
  ): Promise<TradeResult> {
    const side = aiResponse.decision === 'BUY' ? 'buy' : 'sell';
    
    // Get REAL current balance (not from .env)
    const currentBalance = await dbService.getCurrentBalance();
    const positionSizePercentage = parseFloat(process.env.POSITION_SIZE_PERCENTAGE || '50');
    const baseCapitalPerTrade = currentBalance * (positionSizePercentage / 100);
    
    // Apply dynamic size multiplier from filters
    const capitalPerTrade = baseCapitalPerTrade * sizeMultiplier;
    
    // Use leverage from config (default 20x for safer trading)
    const leverage = config.trading.maxLeverage;
    
    // Check if we have enough margin
    const marginRequired = capitalPerTrade;
    const hasMargin = await dbService.reserveMargin(marginRequired);
    
    if (!hasMargin) {
      logger.warn(`❌ Insufficient margin to open position`, {
        currentBalance,
        marginRequired,
        symbol
      });
      return {
        success: false,
        error: 'Insufficient margin',
      };
    }
    
    // Calcola quantity: (capitale * leva) / prezzo
    const quantity = (capitalPerTrade * leverage) / currentPrice;
    
    logger.info(`💰 Position sizing (REAL BALANCE)`, {
      currentBalance,
      baseCapital: baseCapitalPerTrade,
      sizeMultiplier: sizeMultiplier.toFixed(2),
      effectiveCapital: capitalPerTrade.toFixed(2),
      marginRequired,
      confidence: aiResponse.confidence,
      leverage: leverage + 'x',
      currentPrice,
      quantity: quantity.toFixed(6),
    });

    // Genera ID temporaneo per l'ordine pending
    const pendingOrderId = `PENDING_${Date.now()}_${symbol}`;

    try {
      // Get best bid/ask for LIMIT order
      // BUY at BID price (to be a maker), SELL at ASK price
      let limitPrice = currentPrice;
      try {
        const { bid, ask, spread } = await hyperliquidService.getBestBidAsk(symbol);
        // For BUY: place at bid (or slightly above to get filled faster)
        // For SELL: place at ask (or slightly below to get filled faster)
        const aggressiveness = 0.0001; // 0.01% more aggressive to ensure fill
        limitPrice = side === 'buy' 
          ? bid * (1 + aggressiveness)  // Slightly above bid
          : ask * (1 - aggressiveness); // Slightly below ask
        
        logger.warn(`📊 LIMIT order pricing`, {
          side,
          bestBid: bid.toFixed(2),
          bestAsk: ask.toFixed(2),
          spread: spread.toFixed(4) + '%',
          limitPrice: limitPrice.toFixed(2),
        });
      } catch {
        logger.warn('Could not get bid/ask, using mid price');
      }

      // Aggiungi ordine alla lista pending (mostrato in dashboard)
      WebServer.addPendingOrder({
        id: pendingOrderId,
        symbol,
        side,
        limitPrice,
        quantity,
        confidence: aiResponse.confidence,
        reasoning: aiResponse.reasoning,
        createdAt: Date.now(),
        status: 'pending',
        currentPrice,
      });

      logger.info(`💰 Executing ${side.toUpperCase()} LIMIT order`, {
        symbol,
        side,
        quantity,
        limitPrice: limitPrice.toFixed(2),
      });

      const order = await hyperliquidService.placeOrder(
        symbol,
        side,
        quantity,
        limitPrice, // Use LIMIT price at bid/ask
        true // useLimit = true
      );

      // Rimuovi da pending dopo fill
      WebServer.removePendingOrder(pendingOrderId);

      logger.info(`✅ Order executed successfully`, {
        orderId: order.orderId,
        status: order.status,
        filledQuantity: order.filledQuantity,
        price: order.price,
      });

      // Save trade to database
      const decision = {
        timestamp: Date.now(),
        symbol,
        decision: aiResponse.decision,
        confidence: aiResponse.confidence,
        reasoning: aiResponse.reasoning,
        currentPrice,
        indicators: {} as any,
        executed: true,
        orderId: order.orderId,
      };

      await dbService.saveTrade(order, decision, leverage);

      return {
        success: true,
        order,
        decision,
      };
    } catch (error) {
      // Rimuovi ordine pending in caso di errore
      WebServer.removePendingOrder(pendingOrderId);
      
      logger.error('Failed to execute trade', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        decision: {
          timestamp: Date.now(),
          symbol,
          decision: aiResponse.decision,
          confidence: aiResponse.confidence,
          reasoning: aiResponse.reasoning,
          currentPrice,
          indicators: {} as any,
          executed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Determines market condition based on indicators
   */
  private determineMarketCondition(marketSnapshot: any, indicators: any): string {
    const trend = indicatorService.getEMATrend(indicators);
    const volatility = marketSnapshot.volatility;

    if (volatility > 3) return 'Highly Volatile';
    if (volatility > 1.5) return 'Volatile';
    
    if (trend === 'bullish') return 'Bullish Trending';
    if (trend === 'bearish') return 'Bearish Trending';
    return 'Ranging/Sideways';
  }

  /**
   * Checks if trading is allowed based on daily limits
   */
  private canTrade(): boolean {
    if (this.dailyTradeCount >= config.risk.maxDailyTrades) {
      return false;
    }

    if (this.dailyPnL <= -config.risk.maxDailyLoss) {
      return false;
    }

    return true;
  }

  /**
   * Resets daily counters at start of new day
   */
  private resetDailyCountersIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      logger.info('New trading day - resetting daily counters', {
        previousTrades: this.dailyTradeCount,
        previousPnL: this.dailyPnL,
      });

      this.dailyTradeCount = 0;
      this.dailyPnL = 0;
      this.lastResetDate = today;
    }
  }

  /**
   * Saves trade decision to log file and database
   */
  private async saveTradeDecision(decision: TradeDecision): Promise<void> {
    try {
      this.tradeHistory.push(decision);

      // Keep only last 1000 decisions in memory
      if (this.tradeHistory.length > 1000) {
        this.tradeHistory = this.tradeHistory.slice(-1000);
      }

      // Ensure logs directory exists
      const logDir = path.dirname(FILE_PATHS.AI_DECISIONS);
      await fs.mkdir(logDir, { recursive: true });

      // Append to AI decisions file
      await fs.writeFile(
        FILE_PATHS.AI_DECISIONS,
        JSON.stringify(this.tradeHistory, null, 2)
      );

      // Save to database
      await dbService.saveAIDecision(decision, decision.orderId);

      logger.debug('Trade decision saved to file and database');
    } catch (error) {
      logger.error('Failed to save trade decision', error);
    }
  }

  /**
   * Loads trade history from file
   */
  private async loadTradeHistory(): Promise<void> {
    try {
      const data = await fs.readFile(FILE_PATHS.AI_DECISIONS, 'utf-8');
      this.tradeHistory = JSON.parse(data);
      logger.info(`Loaded ${this.tradeHistory.length} historical trade decisions`);
    } catch (error) {
      // File doesn't exist yet, start fresh
      logger.info('No existing trade history found, starting fresh');
      this.tradeHistory = [];
    }
  }

  /**
   * Gets trade statistics
   */
  getStatistics(): {
    totalDecisions: number;
    executedTrades: number;
    buySignals: number;
    sellSignals: number;
    holdSignals: number;
    dailyTrades: number;
    dailyPnL: number;
  } {
    const executed = this.tradeHistory.filter((d) => d.executed);
    
    return {
      totalDecisions: this.tradeHistory.length,
      executedTrades: executed.length,
      buySignals: this.tradeHistory.filter((d) => d.decision === 'BUY').length,
      sellSignals: this.tradeHistory.filter((d) => d.decision === 'SELL').length,
      holdSignals: this.tradeHistory.filter((d) => d.decision === 'HOLD').length,
      dailyTrades: this.dailyTradeCount,
      dailyPnL: this.dailyPnL,
    };
  }
}

// Export singleton instance
export const tradeLoop = new TradeLoop();
export default tradeLoop;
