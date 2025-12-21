import { Hyperliquid } from 'hyperliquid';
import { indicatorService } from '../strategies/indicators';
import aiEngine from '../ai/aiEngine';
import { AIPromptContext, Candle, Indicators, MultiTimeframeIndicators } from '../types';
import { logger } from '../core/logger';
import { EventEmitter } from 'events';

export interface BacktestConfig {
  symbol: string;
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  leverage: number;
  takerFee: number;
  slPercent: number;
  tpPercent: number;
  useAI: boolean; // true = AI decisions, false = indicator-based
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
  exitReason: 'tp' | 'sl' | 'signal' | 'end';
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

    logger.info(`Starting backtest for ${config.symbol}`, {
      startDate: config.startDate.toISOString(),
      endDate: config.endDate.toISOString(),
      initialBalance: config.initialBalance,
    });

    this.emit('status', { status: 'downloading', message: 'Downloading historical data...' });

    // Download historical candles
    const candles = await this.downloadHistoricalCandles(
      config.symbol,
      config.startDate,
      config.endDate
    );

    if (candles.length < 100) {
      throw new Error(`Not enough candles for backtest: ${candles.length}`);
    }

    logger.info(`Downloaded ${candles.length} candles`);
    this.emit('status', { status: 'running', message: `Processing ${candles.length} candles...` });

    // Run simulation
    const result = await this.simulate(config, candles);
    
    result.duration = Date.now() - startTime;

    logger.info('Backtest completed', {
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
    const interval = '1m';
    const batchSize = 5000; // Max candles per request

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
        
        // Move to next batch
        currentStart = response[response.length - 1].t + 60000;

        this.emit('progress', {
          type: 'download',
          current: allCandles.length,
          message: `Downloaded ${allCandles.length} candles...`,
        });

        // Rate limiting
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
      aiConfidence?: number;
      aiReasoning?: string;
    } | null = null;

    let tradeId = 0;
    let maxEquity = balance;
    let maxDrawdown = 0;
    let aiCallCount = 0;

    // Need at least 60 candles for indicators
    const startIndex = 60;

    for (let i = startIndex; i < candles.length; i++) {
      if (this.shouldStop) break;

      const currentCandle = candles[i];
      const historicalCandles = candles.slice(Math.max(0, i - 100), i + 1);
      const currentPrice = currentCandle.close;
      const currentTime = new Date(currentCandle.timestamp);

      // Update equity curve
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
      }

      // Track max drawdown
      if (currentEquity > maxEquity) maxEquity = currentEquity;
      const drawdown = maxEquity - currentEquity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      // Sample equity curve (every 60 candles = 1 hour)
      if (i % 60 === 0) {
        equityCurve.push({ time: currentTime, equity: currentEquity });
      }

      // Check SL/TP if in position
      if (position) {
        const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100 *
          (position.side === 'buy' ? 1 : -1);

        // Stop Loss
        if (pnlPercent <= -config.slPercent) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'sl', ++tradeId
          );
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
          continue;
        }

        // Take Profit
        if (pnlPercent >= config.tpPercent) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'tp', ++tradeId
          );
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
          continue;
        }
      }

      // Get trading decision (every 5 candles to save AI calls)
      if (i % 5 !== 0) continue;

      let decision: SimpleDecision;

      try {
        // Calculate indicators
        const indicators = await indicatorService.getIndicators(historicalCandles);
        const multiTfIndicators = await indicatorService.getMultiTimeframeIndicators(historicalCandles, currentPrice);

        if (config.useAI && aiCallCount < 500) { // Limit AI calls
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
            message: `Processing candle ${i}/${candles.length} (AI calls: ${aiCallCount})`,
          });
        } else {
          decision = this.getIndicatorDecision(multiTfIndicators, currentPrice);
          
          if (i % 100 === 0) {
            this.emit('progress', {
              type: 'indicator',
              current: i,
              total: candles.length,
              message: `Processing candle ${i}/${candles.length}`,
            });
          }
        }
      } catch {
        // Skip this candle if indicator calculation fails
        continue;
      }

      // Execute decision
      if (!position && (decision.decision === 'BUY' || decision.decision === 'SELL')) {
        if (decision.confidence >= 0.55) {
          const quantity = (balance * 0.95) / currentPrice; // Use 95% of balance
          position = {
            side: decision.decision.toLowerCase() as 'buy' | 'sell',
            entryPrice: currentPrice,
            quantity,
            entryTime: currentTime,
            aiConfidence: decision.confidence,
            aiReasoning: decision.reasoning,
          };
        }
      } else if (position && decision.decision !== position.side.toUpperCase() && decision.decision !== 'HOLD') {
        // Signal reversal - close position
        if (decision.confidence >= 0.6) {
          const trade = this.closePosition(
            position, currentPrice, currentTime, config, 'signal', ++tradeId
          );
          trades.push(trade);
          balance += trade.pnl - trade.fees;
          position = null;
        }
      }
    }

    // Close any remaining position at end
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

    // Calculate metrics
    const metrics = this.calculateMetrics(trades, config.initialBalance, balance, maxDrawdown);

    return {
      config,
      trades,
      metrics,
      equityCurve,
      duration: 0,
    };
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
    exitReason: 'tp' | 'sl' | 'signal' | 'end',
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

  private getIndicatorDecision(
    mtf: MultiTimeframeIndicators,
    currentPrice: number
  ): SimpleDecision {
    let bullishSignals = 0;
    let bearishSignals = 0;

    // RSI signals
    if (mtf.rsi.short < 30) bullishSignals += 2;
    else if (mtf.rsi.short < 40) bullishSignals += 1;
    if (mtf.rsi.short > 70) bearishSignals += 2;
    else if (mtf.rsi.short > 60) bearishSignals += 1;

    // EMA trend
    if (mtf.ema.scalping.trend === 'bullish') bullishSignals++;
    if (mtf.ema.scalping.trend === 'bearish') bearishSignals++;
    if (mtf.ema.standard.trend === 'bullish') bullishSignals++;
    if (mtf.ema.standard.trend === 'bearish') bearishSignals++;

    // MACD
    if (mtf.macd.fast.histogram > 0) bullishSignals++;
    else bearishSignals++;
    if (mtf.macd.standard.histogram > 0) bullishSignals++;
    else bearishSignals++;

    // Bollinger Bands
    if (currentPrice <= mtf.bollingerBands.standard.lower) bullishSignals += 2;
    if (currentPrice >= mtf.bollingerBands.standard.upper) bearishSignals += 2;

    // Volume
    if (mtf.volume.isHigh) {
      bullishSignals++;
      bearishSignals++;
    }

    const netSignal = bullishSignals - bearishSignals;
    const confidence = Math.min(0.9, 0.5 + Math.abs(netSignal) * 0.05);

    if (netSignal >= 3) {
      return { decision: 'BUY', confidence, reasoning: `Bullish signals: ${bullishSignals}` };
    } else if (netSignal <= -3) {
      return { decision: 'SELL', confidence, reasoning: `Bearish signals: ${bearishSignals}` };
    }

    return { decision: 'HOLD', confidence: 0.5, reasoning: 'No clear signal' };
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

    // Sharpe Ratio (simplified)
    const returns = trades.map(t => t.pnlPercent);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 1;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 * 24 * 60) : 0; // Annualized

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
