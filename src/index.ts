#!/usr/bin/env node

import commands from './cli/commands';
import { logger } from './core/logger';
import WebServer from './web/server';

/**
 * Main entry point for the Trading AI Agent
 */
async function main(): Promise<void> {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'trade':
        await commands.trade();
        break;

      case 'backtest':
        await commands.backtest();
        break;

      case 'analyze':
        await commands.analyze();
        break;

      case 'report':
        await commands.report();
        break;

      case 'web':
        const port = parseInt(process.env.WEB_PORT || '3000');
        const webServer = new WebServer(port);
        await webServer.start();
        
        // Export webServer for other modules
        (global as any).webServer = webServer;
        
        // Keep server running
        process.on('SIGINT', async () => {
          logger.info('Shutting down web server...');
          await webServer.stop();
          process.exit(0);
        });
        break;

      default:
        console.log(`
╔═══════════════════════════════════════════════════════╗
║              TRADING AI AGENT                         ║
║         Autonomous AI-Driven Trading Bot              ║
╚═══════════════════════════════════════════════════════╝

USAGE:
  npm run trade       Start live trading
  npm run backtest    Run backtest simulation
  npm run analyze     Analyze current market conditions
  npm run report      Generate AI decision report
  npm run web         Start web dashboard interface

OPTIONS:
  All configuration is managed through .env file

EXAMPLES:
  npm run trade       # Start the bot in live/dry-run mode
  npm run backtest    # Test strategy on historical data
  npm run analyze     # Get current market analysis
  npm run web         # Start web dashboard on port 3000

For more information, see README.md
        `);
        break;
    }
  } catch (error) {
    logger.error('Application error', error);
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', error);
  console.error('❌ Unhandled rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

// Run main function
main();
