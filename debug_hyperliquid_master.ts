
import { hyperliquidService } from './src/services/hyperliquidService';
import { logger } from './src/core/logger';
import { config } from './src/utils/config';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  try {
    logger.info('Starting Hyperliquid Master Address Debug...');
    logger.info(`API URL: ${config.hyperliquid.apiUrl}`);
    logger.info(`Wallet Address (Config): ${config.hyperliquid.walletAddress}`);
    
    const account = await hyperliquidService.getAccount();
    
    logger.info('Account Info:', {
      balance: account.balance,
      available: account.availableBalance,
      totalPnL: account.totalPnL,
      positions: account.positions.length
    });

    if (account.positions.length > 0) {
      logger.info('Positions: ' + JSON.stringify(account.positions, null, 2));
    } else {
      logger.info('No open positions found.');
    }

  } catch (error) {
    logger.error('Error in debug script:', error);
  }
}

main();
