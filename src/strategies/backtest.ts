import { logger } from '../core/logger';
import { marketDataService } from '../services/marketDataService';
import { indicatorService } from './indicators';
import { aiEngine } from '../ai/aiEngine';
import {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  EquityPoint,
  AIPromptContext,
} from '../types';
import {
  calculateMaxDrawdown,
  calculateSharpeRatio,
  formatCurrency,
  formatPercentage,
} from '../utils/math';
import { FILE_PATHS, INDICATOR_CONSTANTS } from '../utils/constants';
import fs from 'fs/promises';

/**
 * Backtesting service for simulating trading strategies
 */
class BacktestService {
  /**
   * Runs a backtest on historical data
   */
  async runBacktest(backtestConfig: BacktestConfig): Promise<BacktestResult> {
    logger.info('🔄 Starting backtest', {
      symbol: backtestConfig.symbol,
      startDate: backtestConfig.startDate,
      endDate: backtestConfig.endDate,
    });

    const {
      symbol,
      startDate,
      endDate,
      initialBalance,
      positionSize,
      confidenceThreshold,
    } = backtestConfig;

    try {
      // Fetch historical data
      const startDateTime = new Date(startDate);
      const endDateTime = new Date(endDate);

      logger.info(`Fetching historical data from ${startDate} to ${endDate}`);
      
      const candles = await marketDataService.getHistoricalCandles(
        symbol,
        '1h', // Use hourly candles for backtest
        startDateTime,
        endDateTime
      );

      if (candles.length < INDICATOR_CONSTANTS.MIN_CANDLES_FOR_INDICATORS) {
        throw new Error(
          `Insufficient historical data. Got ${candles.length} candles, need at least ${INDICATOR_CONSTANTS.MIN_CANDLES_FOR_INDICATORS}`
        );
      }

      logger.info(`Loaded ${candles.length} historical candles`);

      // Initialize backtest state
      let balance = initialBalance;
      let position: BacktestTrade | null = null;
      const trades: BacktestTrade[] = [];
      const equityCurve: EquityPoint[] = [];

      // Iterate through historical candles
      for (let i = INDICATOR_CONSTANTS.MIN_CANDLES_FOR_INDICATORS; i < candles.length; i++) {
        const currentCandle = candles[i];
        const historicalCandles = candles.slice(0, i + 1);

        // Calculate indicators
        const indicators = await indicatorService.getIndicators(historicalCandles);

        // Prepare AI context
        const aiContext: AIPromptContext = {
          symbol,
          currentPrice: currentCandle.close,
          indicators,
          recentCandles: historicalCandles.slice(-10),
          accountBalance: balance,
          currentPosition: position ? {
            symbol,
            side: position.side === 'buy' ? 'long' : 'short',
            size: position.quantity,
            entryPrice: position.entryPrice,
            currentPrice: currentCandle.close,
            unrealizedPnL: this.calculateUnrealizedPnL(
              position.entryPrice,
              currentCandle.close,
              position.quantity,
              position.side
            ),
            realizedPnL: 0,
            leverage: 1,
          } : undefined,
          marketCondition: 'Backtesting',
          timestamp: currentCandle.timestamp,
        };

        // Get AI decision (simplified for backtest - can be optimized)
        const aiResponse = await aiEngine.generateDecision(aiContext);

        // Execute trade logic
        if (position) {
          // Check if we should close position
          if (
            (position.side === 'buy' && aiResponse.decision === 'SELL' && aiResponse.confidence >= confidenceThreshold) ||
            (position.side === 'sell' && aiResponse.decision === 'BUY' && aiResponse.confidence >= confidenceThreshold)
          ) {
            // Close position
            const pnl = this.calculatePnL(
              position.entryPrice,
              currentCandle.close,
              position.quantity,
              position.side
            );

            position.exitPrice = currentCandle.close;
            position.pnl = pnl;
            balance += pnl;

            trades.push(position);
            logger.debug(`Closed ${position.side} position at ${currentCandle.close}, P&L: ${formatCurrency(pnl)}`);
            
            position = null;
          }
        } else {
          // Check if we should open position
          if (
            (aiResponse.decision === 'BUY' || aiResponse.decision === 'SELL') &&
            aiResponse.confidence >= confidenceThreshold
          ) {
            const side = aiResponse.decision === 'BUY' ? 'buy' : 'sell';
            const quantity = Math.min(positionSize, balance * 0.1 / currentCandle.close);

            if (balance >= quantity * currentCandle.close) {
              position = {
                timestamp: currentCandle.timestamp,
                symbol,
                side,
                entryPrice: currentCandle.close,
                quantity,
                confidence: aiResponse.confidence,
                reasoning: aiResponse.reasoning,
              };

              logger.debug(`Opened ${side} position at ${currentCandle.close}, quantity: ${quantity}`);
            }
          }
        }

        // Track equity curve
        const currentEquity = position
          ? balance + this.calculateUnrealizedPnL(
              position.entryPrice,
              currentCandle.close,
              position.quantity,
              position.side
            )
          : balance;

        const drawdown = currentEquity < initialBalance
          ? ((initialBalance - currentEquity) / initialBalance) * 100
          : 0;

        equityCurve.push({
          timestamp: currentCandle.timestamp,
          equity: currentEquity,
          drawdown,
        });

        // Progress logging
        if (i % 100 === 0) {
          const progress = ((i / candles.length) * 100).toFixed(1);
          logger.debug(`Backtest progress: ${progress}%`);
        }
      }

      // Close any open position at end
      if (position && candles[candles.length - 1]) {
        const finalPrice = candles[candles.length - 1].close;
        const pnl = this.calculatePnL(
          position.entryPrice,
          finalPrice,
          position.quantity,
          position.side
        );

        position.exitPrice = finalPrice;
        position.pnl = pnl;
        balance += pnl;
        trades.push(position);
      }

      // Calculate results
      const result = this.calculateBacktestMetrics(
        trades,
        initialBalance,
        balance,
        equityCurve
      );

      logger.info('✅ Backtest completed', {
        totalTrades: result.totalTrades,
        winRate: formatPercentage(result.winRate * 100),
        totalPnL: formatCurrency(result.totalPnL),
        roi: formatPercentage(result.roi),
      });

      // Save results
      await this.saveBacktestResults(result);

      return result;
    } catch (error) {
      logger.error('Backtest failed', error);
      throw error;
    }
  }

  /**
   * Calculates P&L for a trade
   */
  private calculatePnL(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    side: 'buy' | 'sell'
  ): number {
    if (side === 'buy') {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }

  /**
   * Calculates unrealized P&L for open position
   */
  private calculateUnrealizedPnL(
    entryPrice: number,
    currentPrice: number,
    quantity: number,
    side: 'buy' | 'sell'
  ): number {
    return this.calculatePnL(entryPrice, currentPrice, quantity, side);
  }

  /**
   * Calculates backtest performance metrics
   */
  private calculateBacktestMetrics(
    trades: BacktestTrade[],
    initialBalance: number,
    finalBalance: number,
    equityCurve: EquityPoint[]
  ): BacktestResult {
    const totalPnL = finalBalance - initialBalance;
    const roi = (totalPnL / initialBalance) * 100;

    const winningTrades = trades.filter((t) => (t.pnl || 0) > 0);
    const losingTrades = trades.filter((t) => (t.pnl || 0) < 0);

    const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;
    const averageProfitPerTrade = trades.length > 0
      ? trades.reduce((sum, t) => sum + (t.pnl || 0), 0) / trades.length
      : 0;

    const equityValues = equityCurve.map((e) => e.equity);
    const maxDrawdown = calculateMaxDrawdown(equityValues);

    // Calculate returns for Sharpe ratio
    const returns = equityCurve.slice(1).map((e, i) => {
      const prevEquity = equityCurve[i].equity;
      return (e.equity - prevEquity) / prevEquity;
    });

    const sharpeRatio = calculateSharpeRatio(returns);

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate,
      totalPnL,
      roi,
      maxDrawdown,
      averageProfitPerTrade,
      sharpeRatio,
      trades,
      equityCurve,
    };
  }

  /**
   * Saves backtest results to file
   */
  private async saveBacktestResults(result: BacktestResult): Promise<void> {
    try {
      await fs.writeFile(
        FILE_PATHS.BACKTEST_RESULTS,
        JSON.stringify(result, null, 2)
      );
      logger.info(`Backtest results saved to ${FILE_PATHS.BACKTEST_RESULTS}`);
    } catch (error) {
      logger.error('Failed to save backtest results', error);
    }
  }

  /**
   * Generates a summary report of backtest results
   */
  generateReport(result: BacktestResult): string {
    const report = `
═══════════════════════════════════════════════════════════
                 BACKTEST RESULTS SUMMARY
═══════════════════════════════════════════════════════════

📊 TRADE STATISTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Trades:           ${result.totalTrades}
Winning Trades:         ${result.winningTrades} (${formatPercentage(result.winRate * 100)})
Losing Trades:          ${result.losingTrades} (${formatPercentage((1 - result.winRate) * 100)})

💰 FINANCIAL PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total P&L:              ${formatCurrency(result.totalPnL)}
ROI:                    ${formatPercentage(result.roi)}
Avg Profit/Trade:       ${formatCurrency(result.averageProfitPerTrade)}
Max Drawdown:           ${formatPercentage(result.maxDrawdown)}

📈 RISK METRICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sharpe Ratio:           ${result.sharpeRatio.toFixed(2)}
Risk/Reward Ratio:      ${result.winRate > 0 ? (result.totalPnL / Math.abs(result.maxDrawdown)).toFixed(2) : 'N/A'}

🏆 BEST/WORST TRADES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Best Trade:             ${formatCurrency(Math.max(...result.trades.map(t => t.pnl || 0)))}
Worst Trade:            ${formatCurrency(Math.min(...result.trades.map(t => t.pnl || 0)))}

═══════════════════════════════════════════════════════════
`;

    return report;
  }
}

// Export singleton instance
export const backtestService = new BacktestService();
export default backtestService;
