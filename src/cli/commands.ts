import { logger } from '../core/logger';
import { tradeLoop } from '../core/tradeLoop';
import { eventDrivenTradeLoop } from '../core/eventDrivenTradeLoop';
import { backtestService } from '../strategies/backtest';
import { marketDataService } from '../services/marketDataService';
import { indicatorService } from '../strategies/indicators';
import { aiEngine } from '../ai/aiEngine';
import { config } from '../utils/config';
import { BacktestConfig } from '../types';
import { formatCurrency, formatPercentage } from '../utils/math';
import WebServer from '../web/server';

/**
 * CLI Commands for the Trading AI Agent
 */
export class Commands {
  /**
   * Start live trading
   */
  async trade(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║         TRADING AI AGENT - LIVE TRADING MODE          ║
╚═══════════════════════════════════════════════════════╝
    `);

    console.log(`📊 Symbol: ${config.trading.baseSymbol}`);
    console.log(`⏱️  Interval: ${config.trading.tradeInterval}`);
    console.log(`🎯 Confidence Threshold: ${config.trading.confidenceThreshold}`);
    console.log(`💰 Position Size: ${config.trading.positionSize}`);
    console.log(`🔒 Dry Run: ${config.system.dryRun ? 'YES' : 'NO'}`);
    console.log('');

    if (!config.system.dryRun && config.system.enableLiveTrading) {
      console.log('⚠️  WARNING: LIVE TRADING IS ENABLED - REAL MONEY AT RISK ⚠️');
      console.log('');
    }

    // Reference to web server for cleanup
    let webServer: WebServer | null = null;

    try {
      // Start Web Dashboard Server (this also starts the event-driven trade loop)
      const port = parseInt(process.env.WEB_PORT || '3000');
      webServer = new WebServer(port);
      await webServer.start();
      logger.info(`🌐 Web dashboard started on http://localhost:${port}`);
      logger.info(`🚀 Event-driven trading is now ACTIVE (real-time, no interval)`);
      
      // Export webServer for other modules
      (global as any).webServer = webServer;
      
      
      // NOTE: tradeLoop.start() removed - using eventDrivenTradeLoop instead
      // The eventDrivenTradeLoop is started inside WebServer.start()
      
      // Position manager not needed - eventDrivenTradeLoop handles TP/SL
      // positionManager.start();

      // Keep the process running
      process.on('SIGINT', async () => {
        console.log('\n\n⏹️  Shutting down gracefully...');
        if (webServer) await webServer.stop();
        eventDrivenTradeLoop.stop();
        this.printStatistics();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        console.log('\n\n⏹️  Shutting down gracefully...');
        if (webServer) await webServer.stop();
        eventDrivenTradeLoop.stop();
        this.printStatistics();
        process.exit(0);
      });
    } catch (error) {
      logger.error('Failed to start trading', error);
      console.error('❌ Failed to start trading:', error);
      process.exit(1);
    }
  }

  /**
   * Run backtest
   */
  async backtest(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║        TRADING AI AGENT - BACKTESTING MODE            ║
╚═══════════════════════════════════════════════════════╝
    `);

    const backtestConfig: BacktestConfig = {
      symbol: config.trading.baseSymbol,
      startDate: process.env.BACKTEST_START_DATE || '2024-01-01',
      endDate: process.env.BACKTEST_END_DATE || '2024-12-31',
      initialBalance: parseFloat(process.env.BACKTEST_INITIAL_BALANCE || '10000'),
      positionSize: config.trading.positionSize,
      confidenceThreshold: config.trading.confidenceThreshold,
    };

    console.log(`📊 Symbol: ${backtestConfig.symbol}`);
    console.log(`📅 Period: ${backtestConfig.startDate} to ${backtestConfig.endDate}`);
    console.log(`💰 Initial Balance: ${formatCurrency(backtestConfig.initialBalance)}`);
    console.log('');
    console.log('Running backtest... This may take several minutes.\n');

    try {
      const result = await backtestService.runBacktest(backtestConfig);
      const report = backtestService.generateReport(result);

      console.log(report);

      // Performance analysis
      const analysis = await aiEngine.analyzePerformance(result.trades, result);
      console.log('🤖 AI PERFORMANCE ANALYSIS:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(analysis);
      console.log('');

      console.log(`✅ Backtest results saved to logs/backtest-results.json`);
    } catch (error) {
      logger.error('Backtest failed', error);
      console.error('❌ Backtest failed:', error);
      process.exit(1);
    }
  }

  /**
   * Analyze current market conditions
   */
  async analyze(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║       TRADING AI AGENT - MARKET ANALYSIS MODE         ║
╚═══════════════════════════════════════════════════════╝
    `);

    const symbol = config.trading.baseSymbol;
    console.log(`📊 Analyzing ${symbol}...\n`);

    try {
      // Get market snapshot
      const snapshot = await marketDataService.getMarketSnapshot(
        symbol,
        config.trading.tradeInterval
      );

      console.log('💹 MARKET SNAPSHOT');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Current Price:     ${formatCurrency(snapshot.currentPrice)}`);
      console.log(`24h Change:        ${formatPercentage(snapshot.priceChange24h)}`);
      console.log(`24h Volume:        ${snapshot.volume24h.toFixed(2)}`);
      console.log(`Volatility:        ${snapshot.volatility.toFixed(2)}%`);
      console.log('');

      // Calculate indicators
      const indicators = await indicatorService.getIndicators(snapshot.recentCandles);

      console.log('📈 TECHNICAL INDICATORS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`RSI (14):          ${indicators.rsi.toFixed(2)}`);
      console.log(`EMA 12:            ${formatCurrency(indicators.ema12)}`);
      console.log(`EMA 26:            ${formatCurrency(indicators.ema26)}`);
      console.log(`EMA Trend:         ${indicatorService.getEMATrend(indicators).toUpperCase()}`);
      console.log(`MACD:              ${indicators.macd.macd.toFixed(4)}`);
      console.log(`MACD Signal:       ${indicators.macd.signal.toFixed(4)}`);
      console.log(`MACD Histogram:    ${indicators.macd.histogram.toFixed(4)}`);
      console.log(`BB Upper:          ${formatCurrency(indicators.bollingerBands.upper)}`);
      console.log(`BB Middle:         ${formatCurrency(indicators.bollingerBands.middle)}`);
      console.log(`BB Lower:          ${formatCurrency(indicators.bollingerBands.lower)}`);
      console.log(`ATR (14):          ${indicators.atr.toFixed(2)}`);
      console.log('');

      // Market analysis
      const analysis = indicatorService.analyzeMarket(
        indicators,
        snapshot.currentPrice,
        snapshot.recentCandles[snapshot.recentCandles.length - 1].volume
      );

      console.log('🔍 MARKET ANALYSIS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Trend:             ${analysis.trend}`);
      console.log(`Strength:          ${analysis.strength}`);
      console.log(`Signals:`);
      analysis.signals.forEach((signal) => {
        console.log(`  • ${signal}`);
      });
      console.log('');

      console.log('✅ Analysis complete');
    } catch (error) {
      logger.error('Analysis failed', error);
      console.error('❌ Analysis failed:', error);
      process.exit(1);
    }
  }

  /**
   * Generate report of AI decisions
   */
  async report(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║      TRADING AI AGENT - DECISION REPORT MODE          ║
╚═══════════════════════════════════════════════════════╝
    `);

    try {
      const stats = tradeLoop.getStatistics();

      console.log('📊 TRADING STATISTICS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Total Decisions:   ${stats.totalDecisions}`);
      console.log(`Executed Trades:   ${stats.executedTrades}`);
      console.log(`Buy Signals:       ${stats.buySignals}`);
      console.log(`Sell Signals:      ${stats.sellSignals}`);
      console.log(`Hold Signals:      ${stats.holdSignals}`);
      console.log(`Daily Trades:      ${stats.dailyTrades}`);
      console.log(`Daily P&L:         ${formatCurrency(stats.dailyPnL)}`);
      console.log('');

      console.log('📁 Decision logs stored in: logs/ai-decisions.json');
      console.log('');
    } catch (error) {
      logger.error('Report generation failed', error);
      console.error('❌ Report generation failed:', error);
      process.exit(1);
    }
  }

  /**
   * Print trading statistics
   */
  private printStatistics(): void {
    try {
      const stats = tradeLoop.getStatistics();
      console.log('\n📊 Session Statistics:');
      console.log(`  Total Decisions: ${stats.totalDecisions}`);
      console.log(`  Executed Trades: ${stats.executedTrades}`);
      console.log(`  Daily P&L: ${formatCurrency(stats.dailyPnL)}`);
    } catch (error) {
      // Ignore errors during shutdown
    }
  }
}

export default new Commands();
