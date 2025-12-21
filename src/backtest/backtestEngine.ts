import { Hyperliquid } from 'hyperliquid';
import { indicatorService } from '../strategies/indicators';
import aiEngine from '../ai/aiEngine';
import { AIPromptContext, Candle, Indicators, MultiTimeframeIndicators } from '../types';
import { logger } from '../core/logger';
import { EventEmitter } from 'events';

/**
 * BACKTEST ENGINE - ALIGNED WITH LIVE TRADING
 * 
 * This backtest uses the SAME parameters and logic as live trading:
 * - Same SL/TP percentages (8%/4% default)
 * - Same trailing stop logic
 * - Same confidence thresholds (70%+)
 * - Same indicator-based decisions (approximating order book signals)
 * - Same smart exit logic (using indicator reversals)
 * 
 * NOTE: Order book data is not available historically, so we use
 * multi-timeframe indicators to approximate order book signals.
 */

export interface BacktestConfig {
  symbol: string;
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  leverage: number;
  takerFee: number;
  slPercent: number;  // Default: 8% (matches positionManager)
  tpPercent: number;  // Default: 4% (matches positionManager)
  useAI: boolean;
}

export interface BacktestTrade {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  entryTime: Date;
  exitTime: Date;
  pnl: number;
  pnlPercent: number;
  fees: number;
  exitReason: 'tp' | 'sl' | 'trailing' | 'smart_exit' | 'signal' | 'end';
  aiConfidence?: number;
  aiReasoning?: string;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  metrics: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnL: number;
    totalFees: number;
    netPnL: number;
    roi: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    profitFactor: number;
    averageWin: number;
    averageLoss: number;
    averageHoldTime: number;
    largestWin: number;
    largestLoss: number;
  };
  equityCurve: { time: Date; equity: number }[];
  duration: number;
}

interface SimpleDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
}

// ========================================
// PARAMETERS ALIGNED WITH LIVE TRADING
// (from positionManager.ts and adaptiveParameters.ts)
// ========================================
const LIVE_ALIGNED_PARAMS = {
  // From positionManager.ts
  DEFAULT_STOP_LOSS_PERCENT: 8.0,
  DEFAULT_TAKE_PROFIT_PERCENT: 4.0,
  TRAILING_STOP_ACTIVATION_PERCENT: 1.5,
  TRAILING_STOP_DISTANCE_PERCENT: 1.0,
  MAX_POSITION_AGE_CANDLES: 60, // 60 minutes in 1-min candles

  // From adaptiveParameters.ts
  MIN_TRADE_CONFIDENCE: 0.70,  // 70% minimum

  // Smart exit thresholds (approximating order book reversals with indicators)
  SMART_EXIT_MIN_PROFIT_PERCENT: 0.5,
  RSI_REVERSAL_OVERBOUGHT: 75,
  RSI_REVERSAL_OVERSOLD: 25,
  MOMENTUM_REVERSAL_THRESHOLD: 0.15,
};

export class BacktestEngine extends EventEmitter {
  private sdk: Hyperliquid;
  private shouldStop = false;

  constructor() {
    super();
    this.sdk = new Hyperliquid({
      enableWs: false,
    });
  }

  async runBacktest(config: BacktestConfig): Promise<BacktestResult> {
    this.shouldStop = false;
    const startTime = Date.now();

    // Use live-aligned defaults if user provided standard values
    const alignedConfig = {
      ...config,
      slPercent: config.slPercent || LIVE_ALIGNED_PARAMS.DEFAULT_STOP_LOSS_PERCENT,
      tpPercent: config.tpPercent || LIVE_ALIGNED_PARAMS.DEFAULT_TAKE_PROFIT_PERCENT,
    };

    logger.info(`Starting ALIGNED backtest for ${alignedConfig.symbol}`, {
      startDate: alignedConfig.startDate.toISOString(),
      endDate: alignedConfig.endDate.toISOString(),
      initialBalance: alignedConfig.initialBalance,
      slPercent: alignedConfig.slPercent,
      tpPercent: alignedConfig.tpPercent,
      leverage: alignedConfig.leverage,
    });

    this.emit('status', { status: 'downloading', message: 'Downloading historical data...' });

    const candles = await this.downloadHistoricalCandles(
      alignedConfig.symbol,
      alignedConfig.startDate,
      alignedConfig.endDate
    );

    if (candles.length < 100) {
      throw new Error(`Not enough candles for backtest: ${candles.length}`);
    }

    logger.info(`Downloaded ${candles.length} candles`);
    this.emit('status', { status: 'running', message: `Processing ${candles.length} candles...` });

    const result = await this.simulate(alignedConfig, candles);
    result.duration = Date.now() - startTime;

    logger.info('ALIGNED backtest completed', {
      trades: result.metrics.totalTrades,
      winRate: result.metrics.winRate.toFixed(2),
      netPnL: result.metrics.netPnL.toFixed(2),
      duration: `${(result.duration / 1000).toFixed(1)}s`,
    });

    this.emit('complete', result);
    return result;
  }

  stop() {
    this.shouldStop = true;
  }

  private async downloadHistoricalCandles(
    symbol: string,
    startDate: Date,
    endDate: Date
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    const interval = '1m'; // 1-minute candles like live trading
    const batchSize = 5000;

    let currentStart = startDate.getTime();
    const endTime = endDate.getTime();

    while (currentStart < endTime) {
      try {
        const response = await this.sdk.info.getCandleSnapshot(
          symbol,
          interval,
          currentStart,
          Math.min(currentStart + batchSize * 60 * 1000, endTime)
        );

        if (!response || response.length === 0) break;

        const candles = response.map((c: any) => ({
          timestamp: c.t,
          open: parseFloat(c.o),
          high: parseFloat(c.h),
          low: parseFloat(c.l),
          close: parseFloat(c.c),
          volume: parseFloat(c.v),
        }));

        allCandles.push(...candles);
        currentStart = response[response.length - 1].t + 60000;

        this.emit('progress', {
          type: 'download',
          current: allCandles.length,
          message: `Downloaded ${allCandles.length} candles...`,
        });

        await this.sleep(100);
      } catch (error) {
        logger.error('Error downloading candles', { error });
        break;
      }
    }

    return allCandles.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async simulate(config: BacktestConfig, candles: Candle[]): Promise<BacktestResult> {
    const trades: BacktestTrade[] = [];
    const equityCurve: { time: Date; equity: number }[] = [];

    let balance = config.initialBalance;
    let position: {
      side: 'buy' | 'sell';
      entryPrice: number;
      quantity: number;
      entryTime: Date;
      entryIndex: number;
      highestPrice: number;  // For trailing stop
      lowestPrice: number;   // For trailing stop
      aiConfidence?: number;
      aiReasoning?: string;
    } | null = null;

    let tradeId = 0;
    let maxEquity = balance;
    let maxDrawdown = 0;
    let aiCallCount = 0;

    // Track momentum for smart exit
    let recentIndicators: { rsi: number; macdHist: number }[] = [];

    const startIndex = 60; // Need candles for indicators

    for (let i = startIndex; i < candles.length; i++) {
      if (this.shouldStop) break;

      const currentCandle = candles[i];
      const historicalCandles = candles.slice(Math.max(0, i - 100), i + 1);
      const currentPrice = currentCandle.close;
      const currentTime = new Date(currentCandle.timestamp);

      // ========================================
      // EQUITY TRACKING
      // ========================================
      let currentEquity = balance;
      if (position) {
        const unrealizedPnL = this.calculatePnL(
          position.side,
          position.entryPrice,
          currentPrice,
          position.quantity,
          config.leverage
        );
        currentEquity = balance + unrealizedPnL;

        // Update trailing stop prices
        if (position.side === 'buy' && currentPrice > position.highestPrice) {
          position.highestPrice = currentPrice;
        } else if (position.side === 'sell' && currentPrice < position.lowestPrice) {
          position.lowestPrice = currentPrice;
        }
      }

      if (currentEquity > maxEquity) maxEquity = currentEquity;
      const drawdown = maxEquity - currentEquity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      if (i % 60 === 0) {
        equityCurve.push({ time: currentTime, equity: currentEquity });
      }

      // ========================================
      // POSITION EXIT CHECKS (aligned with positionManager)
      // ========================================
      if (position) {
        const pnlPercent = this.calculatePnLPercent(position, currentPrice, config.leverage);
        const positionAge = i - position.entryIndex;

        // 1. STOP LOSS (same as positionManager)
        if (pnlPercent <= -config.slPercent) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'sl', ++tradeId
          );
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
          recentIndicators = [];
          continue;
        }

        // 2. TAKE PROFIT (same as positionManager)
        if (pnlPercent >= config.tpPercent) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'tp', ++tradeId
          );
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
          recentIndicators = [];
          continue;
        }

        // 3. TRAILING STOP (same as positionManager)
        if (pnlPercent >= LIVE_ALIGNED_PARAMS.TRAILING_STOP_ACTIVATION_PERCENT) {
          let trailingStopHit = false;

          if (position.side === 'buy') {
            const trailingStopPrice = position.highestPrice *
              (1 - LIVE_ALIGNED_PARAMS.TRAILING_STOP_DISTANCE_PERCENT / 100);
            if (currentPrice <= trailingStopPrice) {
              trailingStopHit = true;
            }
          } else {
            const trailingStopPrice = position.lowestPrice *
              (1 + LIVE_ALIGNED_PARAMS.TRAILING_STOP_DISTANCE_PERCENT / 100);
            if (currentPrice >= trailingStopPrice) {
              trailingStopHit = true;
            }
          }

          if (trailingStopHit) {
            const trade = this.closePosition(
              position, currentPrice, currentTime, config, 'trailing', ++tradeId
            );
            trades.push(trade);
            balance += trade.pnl - trade.fees;
            position = null;
            recentIndicators = [];
            continue;
          }
        }

        // 4. SMART EXIT (approximating positionManager.checkSmartExit)
        if (pnlPercent >= LIVE_ALIGNED_PARAMS.SMART_EXIT_MIN_PROFIT_PERCENT) {
          try {
            const indicators = await indicatorService.getIndicators(historicalCandles);

            // Store for momentum tracking
            recentIndicators.push({
              rsi: indicators.rsi,
              macdHist: indicators.macd.histogram
            });
            if (recentIndicators.length > 5) recentIndicators.shift();

            const smartExitReason = this.checkSmartExit(
              position.side,
              indicators,
              recentIndicators,
              pnlPercent
            );

            if (smartExitReason) {
              const trade = this.closePosition(
                position, currentPrice, currentTime, config, 'smart_exit', ++tradeId
              );
              trade.aiReasoning = smartExitReason;
              trades.push(trade);
              balance += trade.pnl - trade.fees;
              position = null;
              recentIndicators = [];
              continue;
            }
          } catch {
            // Skip if indicator error
          }
        }

        // 5. MAX POSITION AGE (fallback, like positionManager)
        if (position && positionAge >= LIVE_ALIGNED_PARAMS.MAX_POSITION_AGE_CANDLES) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'end', ++tradeId
          );
          trade.aiReasoning = `Time exit after ${positionAge} minutes`;
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
          recentIndicators = [];
          continue;
        }
      }

      // ========================================
      // ENTRY DECISION (every 5 candles, like live)
      // ========================================
      if (i % 5 !== 0) continue;

      let decision: SimpleDecision;

      try {
        const indicators = await indicatorService.getIndicators(historicalCandles);
        const multiTfIndicators = await indicatorService.getMultiTimeframeIndicators(
          historicalCandles,
          currentPrice
        );

        if (config.useAI && aiCallCount < 500) {
          decision = await this.getAIDecision(
            config.symbol,
            currentPrice,
            indicators,
            multiTfIndicators,
            historicalCandles.slice(-10),
            balance,
            position
          );
          aiCallCount++;

          this.emit('progress', {
            type: 'ai',
            current: i,
            total: candles.length,
            aiCalls: aiCallCount,
            message: `Processing ${i}/${candles.length} (AI: ${aiCallCount})`,
          });
        } else {
          // Use indicator-based decision (approximating order book strategy)
          decision = this.getAlignedDecision(indicators, multiTfIndicators, currentPrice);

          if (i % 100 === 0) {
            this.emit('progress', {
              type: 'indicator',
              current: i,
              total: candles.length,
              message: `Processing ${i}/${candles.length}`,
            });
          }
        }
      } catch {
        continue;
      }

      // ========================================
      // ENTRY EXECUTION (with live-aligned confidence)
      // ========================================
      if (!position && (decision.decision === 'BUY' || decision.decision === 'SELL')) {
        // Use SAME confidence threshold as live (70%+)
        if (decision.confidence >= LIVE_ALIGNED_PARAMS.MIN_TRADE_CONFIDENCE) {
          const quantity = (balance * 0.95) / currentPrice;
          position = {
            side: decision.decision.toLowerCase() as 'buy' | 'sell',
            entryPrice: currentPrice,
            quantity,
            entryTime: currentTime,
            entryIndex: i,
            highestPrice: currentPrice,
            lowestPrice: currentPrice,
            aiConfidence: decision.confidence,
            aiReasoning: decision.reasoning,
          };
        }
      } else if (position && decision.decision !== position.side.toUpperCase() && decision.decision !== 'HOLD') {
        // Signal reversal - stricter confidence for reversals
        if (decision.confidence >= 0.75) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'signal', ++tradeId
          );
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
          recentIndicators = [];
        }
      }
    }

    // Close remaining position
    if (position) {
      const lastCandle = candles[candles.length - 1];
      const trade = this.closePosition(
        position,
        lastCandle.close,
        new Date(lastCandle.timestamp),
        config,
        'end',
        ++tradeId
      );
      trades.push(trade);
      balance += trade.pnl - trade.fees;
    }

    const metrics = this.calculateMetrics(trades, config.initialBalance, balance, maxDrawdown);

    return {
      config,
      trades,
      metrics,
      equityCurve,
      duration: 0,
    };
  }

  /**
   * SMART EXIT - Approximates positionManager.checkSmartExit using indicators
   * Since we don't have order book data, we detect reversals via:
   * - RSI extreme levels
   * - MACD histogram reversal
   * - Momentum deterioration
   */
  private checkSmartExit(
    side: 'buy' | 'sell',
    indicators: Indicators,
    recentIndicators: { rsi: number; macdHist: number }[],
    currentPnlPercent: number
  ): string | null {
    // 1. RSI REVERSAL
    if (side === 'buy' && indicators.rsi >= LIVE_ALIGNED_PARAMS.RSI_REVERSAL_OVERBOUGHT) {
      return `RSI overbought (${indicators.rsi.toFixed(0)}) - reversal risk`;
    }
    if (side === 'sell' && indicators.rsi <= LIVE_ALIGNED_PARAMS.RSI_REVERSAL_OVERSOLD) {
      return `RSI oversold (${indicators.rsi.toFixed(0)}) - reversal risk`;
    }

    // 2. MACD HISTOGRAM REVERSAL
    if (recentIndicators.length >= 3) {
      const recent = recentIndicators.slice(-3);
      const histogramTrend = recent[2].macdHist - recent[0].macdHist;

      // Histogram turning against position
      if (side === 'buy' && histogramTrend < -LIVE_ALIGNED_PARAMS.MOMENTUM_REVERSAL_THRESHOLD) {
        return `MACD momentum weakening - protecting profit`;
      }
      if (side === 'sell' && histogramTrend > LIVE_ALIGNED_PARAMS.MOMENTUM_REVERSAL_THRESHOLD) {
        return `MACD momentum weakening - protecting profit`;
      }
    }

    // 3. RSI MOMENTUM SHIFT
    if (recentIndicators.length >= 3 && currentPnlPercent >= 1.0) {
      const rsiChange = recentIndicators[recentIndicators.length - 1].rsi -
        recentIndicators[0].rsi;

      if (side === 'buy' && rsiChange < -15) {
        return `RSI declining sharply - taking profit`;
      }
      if (side === 'sell' && rsiChange > 15) {
        return `RSI rising sharply - taking profit`;
      }
    }

    return null;
  }

  /**
   * ALIGNED DECISION - Approximates ORDER_BOOK strategy using indicators
   * Uses stricter thresholds matching live trading filters
   */
  private getAlignedDecision(
    _indicators: Indicators,
    mtf: MultiTimeframeIndicators,
    currentPrice: number
  ): SimpleDecision {
    let bullishScore = 0;
    let bearishScore = 0;

    // ========================================
    // TREND ALIGNMENT (like order book trend check)
    // ========================================

    // EMA Trend (strong weight)
    if (mtf.ema.scalping.trend === 'bullish') bullishScore += 2;
    if (mtf.ema.scalping.trend === 'bearish') bearishScore += 2;
    if (mtf.ema.standard.trend === 'bullish') bullishScore += 1;
    if (mtf.ema.standard.trend === 'bearish') bearishScore += 1;

    // RSI (like order book imbalance detection)
    if (mtf.rsi.short < 30) bullishScore += 3;
    else if (mtf.rsi.short < 40) bullishScore += 1;
    if (mtf.rsi.short > 70) bearishScore += 3;
    else if (mtf.rsi.short > 60) bearishScore += 1;

    // MACD Momentum
    if (mtf.macd.fast.histogram > 0 && mtf.macd.fast.histogram > mtf.macd.standard.histogram * 0.5) {
      bullishScore += 2;
    }
    if (mtf.macd.fast.histogram < 0 && mtf.macd.fast.histogram < mtf.macd.standard.histogram * 0.5) {
      bearishScore += 2;
    }

    // Bollinger Band Breakout (like order book breakout confirmation)
    const bbWidth = (mtf.bollingerBands.standard.upper - mtf.bollingerBands.standard.lower) /
      mtf.bollingerBands.standard.middle;
    if (currentPrice <= mtf.bollingerBands.standard.lower && bbWidth > 0.02) {
      bullishScore += 2;
    }
    if (currentPrice >= mtf.bollingerBands.standard.upper && bbWidth > 0.02) {
      bearishScore += 2;
    }

    // Volume confirmation
    if (mtf.volume.isHigh) {
      if (bullishScore > bearishScore) bullishScore += 1;
      if (bearishScore > bullishScore) bearishScore += 1;
    }

    // ========================================
    // FILTER: Avoid consolidated/ranging markets
    // (like order book CONSOLIDATION detection)
    // ========================================
    const netScore = Math.abs(bullishScore - bearishScore);
    if (netScore < 3) {
      return { decision: 'HOLD', confidence: 0.5, reasoning: 'No clear trend - HOLD' };
    }

    // Calculate confidence (scaled to match live trading requirements)
    // Need 70%+ confidence for entry
    const rawConfidence = 0.5 + netScore * 0.05;
    const confidence = Math.min(0.95, rawConfidence);

    if (bullishScore > bearishScore && bullishScore >= 5) {
      return {
        decision: 'BUY',
        confidence,
        reasoning: `Bullish: score ${bullishScore} vs ${bearishScore}`
      };
    } else if (bearishScore > bullishScore && bearishScore >= 5) {
      return {
        decision: 'SELL',
        confidence,
        reasoning: `Bearish: score ${bearishScore} vs ${bullishScore}`
      };
    }

    return { decision: 'HOLD', confidence: 0.5, reasoning: 'Insufficient signal strength' };
  }

  private calculatePnLPercent(
    position: { side: 'buy' | 'sell'; entryPrice: number },
    currentPrice: number,
    leverage: number
  ): number {
    const direction = position.side === 'buy' ? 1 : -1;
    return ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * direction * leverage;
  }

  private closePosition(
    position: {
      side: 'buy' | 'sell';
      entryPrice: number;
      quantity: number;
      entryTime: Date;
      aiConfidence?: number;
      aiReasoning?: string;
    },
    exitPrice: number,
    exitTime: Date,
    config: BacktestConfig,
    exitReason: 'tp' | 'sl' | 'trailing' | 'smart_exit' | 'signal' | 'end',
    tradeId: number
  ): BacktestTrade {
    const pnl = this.calculatePnL(
      position.side,
      position.entryPrice,
      exitPrice,
      position.quantity,
      config.leverage
    );
    const fees = (position.entryPrice * position.quantity + exitPrice * position.quantity) * config.takerFee;
    const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100 *
      (position.side === 'buy' ? 1 : -1);

    return {
      id: tradeId,
      symbol: config.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      leverage: config.leverage,
      entryTime: position.entryTime,
      exitTime,
      pnl,
      pnlPercent,
      fees,
      exitReason,
      aiConfidence: position.aiConfidence,
      aiReasoning: position.aiReasoning,
    };
  }

  private calculatePnL(
    side: 'buy' | 'sell',
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    leverage: number
  ): number {
    const direction = side === 'buy' ? 1 : -1;
    return (exitPrice - entryPrice) * quantity * direction * leverage;
  }

  private async getAIDecision(
    symbol: string,
    currentPrice: number,
    indicators: Indicators,
    multiTfIndicators: MultiTimeframeIndicators,
    recentCandles: Candle[],
    balance: number,
    position: any
  ): Promise<SimpleDecision> {
    try {
      const context: AIPromptContext = {
        symbol,
        currentPrice,
        indicators,
        multiTfIndicators,
        recentCandles,
        accountBalance: balance,
        timestamp: Date.now(),
        currentPosition: position ? {
          symbol,
          side: position.side === 'buy' ? 'long' : 'short',
          size: position.quantity,
          entryPrice: position.entryPrice,
          currentPrice: currentPrice,
          unrealizedPnL: this.calculatePnL(position.side, position.entryPrice, currentPrice, position.quantity, 1),
          realizedPnL: 0,
          leverage: 1,
        } : undefined,
        marketCondition: this.getMarketCondition(indicators),
        openPositions: position ? [position] : [],
        hasOpenPosition: !!position,
        existingPosition: position,
        unrealizedPnl: 0,
        unrealizedPnlPercentage: 0,
      };

      const response = await aiEngine.generateDecision(context);
      return {
        decision: response.decision,
        confidence: response.confidence,
        reasoning: response.reasoning,
      };
    } catch (error) {
      logger.error('AI decision error in backtest', { error });
      return { decision: 'HOLD', confidence: 0, reasoning: 'AI error' };
    }
  }

  private getMarketCondition(indicators: Indicators): string {
    const atrPercent = (indicators.atr / indicators.bollingerBands.middle) * 100;
    if (atrPercent > 1) return 'volatile';
    if (atrPercent < 0.3) return 'ranging';
    return 'normal';
  }

  private calculateMetrics(
    trades: BacktestTrade[],
    initialBalance: number,
    finalBalance: number,
    maxDrawdown: number
  ) {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl <= 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);
    const netPnL = totalPnL - totalFees;

    const totalWins = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

    const averageHoldTime = trades.length > 0
      ? trades.reduce((sum, t) => sum + (t.exitTime.getTime() - t.entryTime.getTime()), 0) / trades.length / 60000
      : 0;

    const returns = trades.map(t => t.pnlPercent);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 1;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 * 24 * 60) : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
      totalPnL,
      totalFees,
      netPnL,
      roi: ((finalBalance - initialBalance) / initialBalance) * 100,
      maxDrawdown,
      maxDrawdownPercent: (maxDrawdown / initialBalance) * 100,
      sharpeRatio,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
      averageWin: winningTrades.length > 0 ? totalWins / winningTrades.length : 0,
      averageLoss: losingTrades.length > 0 ? totalLosses / losingTrades.length : 0,
      averageHoldTime,
      largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0,
      largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const backtestEngine = new BacktestEngine();
