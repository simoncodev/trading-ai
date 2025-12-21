import { Hyperliquid } from 'hyperliquid';
import { config } from '../utils/config';
import { RETRY_CONFIG } from '../utils/constants';
import { logger } from '../core/logger';
import {
  Market,
  Account,
  OrderResponse,
  Candle,
} from '../types';

/**
 * Service for interacting with Hyperliquid API using community SDK
 */
class HyperliquidService {
  private sdk: Hyperliquid;
  private walletAddress: string;

  constructor() {
    // Get configuration
    const privateKey = config.hyperliquid.secret;
    this.walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS || '';
    
    // Determine if we're on testnet based on API URL
    const isTestnet = config.hyperliquid.apiUrl.includes('testnet');

    // Initialize SDK
    this.sdk = new Hyperliquid({
      privateKey,
      testnet: isTestnet,
      walletAddress: this.walletAddress,
      enableWs: false, // Disable WebSocket for now
    });

    logger.info(`Hyperliquid SDK initialized (${isTestnet ? 'TESTNET' : 'MAINNET'})`);
  }

  /**
   * Retry wrapper for API calls with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    retries = RETRY_CONFIG.maxRetries
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (retries === 0) {
        throw error;
      }

      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, RETRY_CONFIG.maxRetries - retries),
        RETRY_CONFIG.maxDelay
      );

      logger.warn(`Retrying after ${delay}ms. Retries left: ${retries - 1}`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return this.retryWithBackoff(fn, retries - 1);
    }
  }

  /**
   * Normalizza il simbolo per l'API Hyperliquid
   * Converte: BTC-USDC -> BTC-PERP, ETH-USD -> ETH-PERP, SOL-USDC -> SOL-PERP
   */
  private normalizeSymbol(symbol: string): string {
    // Estrai base asset (BTC, ETH, SOL, ecc.)
    const baseAsset = symbol.split('-')[0];
    // Hyperliquid usa sempre formato COIN-PERP
    return `${baseAsset}-PERP`;
  }

  /**
   * Converte simbolo in formato PERP per order book
   * BTC-USDC -> BTC-PERP (Hyperliquid richiede formato -PERP)
   */
  private toOrderBookSymbol(symbol: string): string {
    return this.normalizeSymbol(symbol);
  }

  /**
   * Fetches all available markets
   */
  async getMarkets(): Promise<Market[]> {
    logger.debug('Fetching markets from Hyperliquid');

    return this.retryWithBackoff(async () => {
      const metaResponse = await this.sdk.info.perpetuals.getMeta();
      
      // Transform API response to Market type
      const markets = metaResponse.universe || [];
      return markets.map((market: any) => ({
        symbol: market.name,
        name: market.name,
        baseAsset: market.name,
        quoteAsset: 'USD',
        minOrderSize: 0.001,
        maxOrderSize: 1000,
        tickSize: 0.1,
        status: market.onlyIsolated ? 'inactive' : 'active',
      }));
    });
  }

  /**
   * Fetches account information
   */
  async getAccount(): Promise<Account> {
    logger.debug('Fetching account information');

    return this.retryWithBackoff(async () => {
      const clearinghouseState = await this.sdk.info.perpetuals.getClearinghouseState(this.walletAddress);

      const marginSummary = clearinghouseState.marginSummary;
      const assetPositions = clearinghouseState.assetPositions || [];

      // Calcola P&L totale dalle posizioni
      const positions = assetPositions.map((pos: any) => ({
        symbol: pos.position.coin,
        side: (parseFloat(pos.position.szi) > 0 ? 'long' : 'short') as 'long' | 'short',
        size: Math.abs(parseFloat(pos.position.szi)),
        entryPrice: parseFloat(pos.position.entryPx || '0'),
        currentPrice: parseFloat(pos.position.positionValue) / Math.abs(parseFloat(pos.position.szi) || 1),
        unrealizedPnL: parseFloat(pos.position.unrealizedPnl),
        realizedPnL: parseFloat(pos.position.cumFunding?.allTime || '0'),
        leverage: parseFloat(pos.position.leverage?.value || '1'),
      }));

      // Somma P&L totale
      const totalPnL = positions.reduce((sum, pos) => sum + pos.unrealizedPnL + pos.realizedPnL, 0);

      return {
        balance: parseFloat(marginSummary.accountValue),
        availableBalance: parseFloat(clearinghouseState.withdrawable),
        positions,
        totalPnL,
        dailyPnL: totalPnL, // In futuro filtrare solo oggi
      };
    });
  }

  /**
   * Places an order on Hyperliquid
   */
  async placeOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price?: number
  ): Promise<OrderResponse> {
    logger.info(`Placing ${side} order for ${quantity} ${symbol}`, {
      symbol,
      side,
      quantity,
      price,
    });

    // Dry run mode - REALISTIC SIMULATION
    if (config.system.dryRun) {
      // Simulate network latency (50-150ms)
      const latency = 50 + Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, latency));
      
      // Simulate slippage (0.02% - 0.08% against you)
      const slippagePercent = 0.0002 + Math.random() * 0.0006; // 0.02% - 0.08%
      const slippageDirection = side === 'buy' ? 1 : -1; // Buy = price goes up, Sell = price goes down
      const slippagePrice = (price || 0) * (1 + slippageDirection * slippagePercent);
      
      // Simulate partial fills (90-100% filled)
      const fillRate = 0.90 + Math.random() * 0.10;
      const filledQty = quantity * fillRate;
      
      // Calculate realistic fee (0.035% taker fee for market-like orders)
      const notionalValue = filledQty * slippagePrice;
      const takerFeeRate = 0.00035; // 0.035% taker fee
      const estimatedFee = notionalValue * takerFeeRate;
      
      logger.warn('DRY RUN MODE: Realistic simulation', {
        latencyMs: latency.toFixed(0),
        slippagePercent: (slippagePercent * 100).toFixed(4) + '%',
        requestedPrice: price?.toFixed(2),
        filledPrice: slippagePrice.toFixed(2),
        fillRate: (fillRate * 100).toFixed(1) + '%',
        fee: estimatedFee.toFixed(4),
      });
      
      return {
        orderId: `DRY_RUN_${Date.now()}`,
        symbol,
        side,
        type: price ? 'limit' : 'market',
        quantity: filledQty, // Partial fill
        price: slippagePrice, // Slippage applied
        status: 'filled', // DRY_RUN orders are always considered filled
        filledQuantity: filledQty,
        timestamp: Date.now(),
        fee: estimatedFee,
      };
    }

    return this.retryWithBackoff(async () => {
      const coin = this.normalizeSymbol(symbol);
      
      logger.debug(`Placing order on Hyperliquid`, {
        coin,
        is_buy: side === 'buy',
        sz: quantity,
        limit_px: price ? price.toString() : '0',
      });

      // Use the SDK's placeOrder method
      const orderResult = await this.sdk.exchange.placeOrder({
        coin, // BTC-PERP, ETH-PERP, SOL-PERP, ecc.
        is_buy: side === 'buy',
        sz: quantity,
        limit_px: price ? price.toString() : '0',
        order_type: price ? { limit: { tif: 'Gtc' } } : { limit: { tif: 'Ioc' } },
        reduce_only: false,
      });

      logger.debug('Order result received', { orderResult });

      // Extract order info from response
      const status = orderResult?.response?.data?.statuses?.[0];
      
      logger.debug('Order status', { status });
      
      if (!status || status.error) {
        const errorMsg = status?.error || 'Order failed - no status returned';
        logger.error('Order placement failed', { 
          error: errorMsg, 
          fullStatus: status,
          coin,
          side,
          quantity 
        });
        throw new Error(errorMsg);
      }

      return {
        orderId: status.resting?.oid?.toString() || `FILLED_${Date.now()}`,
        symbol,
        side,
        type: price ? 'limit' : 'market',
        quantity,
        price: parseFloat(status.filled?.avgPx || price?.toString() || '0'),
        status: status.filled ? 'filled' : 'pending',
        filledQuantity: parseFloat(status.filled?.totalSz || '0'),
        timestamp: Date.now(),
        fee: parseFloat(status.filled?.fee || '0'),
      };
    });
  }

  /**
   * Fetches historical candle data
   */
  async getCandles(
    symbol: string,
    interval: string,
    limit = 100
  ): Promise<Candle[]> {
    logger.debug(`Fetching ${limit} candles for ${symbol} (${interval})`);

    return this.retryWithBackoff(async () => {
      const coin = this.normalizeSymbol(symbol);
      const endTime = Date.now();
      const startTime = endTime - (limit * this.getIntervalMs(interval));

      // SDK expects separate parameters, not an object
      const candleSnapshot: any = await (this.sdk.info as any).getCandleSnapshot(
        coin,
        interval,
        startTime,
        endTime
      );

      return candleSnapshot.map((candle: any) => ({
        timestamp: candle.t,
        open: parseFloat(candle.o),
        high: parseFloat(candle.h),
        low: parseFloat(candle.l),
        close: parseFloat(candle.c),
        volume: parseFloat(candle.v),
      }));
    });
  }

  /**
   * Helper to convert interval string to milliseconds
   */
  private getIntervalMs(interval: string): number {
    const map: Record<string, number> = {
      '1m': 60000,
      '3m': 180000,
      '5m': 300000,
      '15m': 900000,
      '30m': 1800000,
      '1h': 3600000,
      '2h': 7200000,
      '4h': 14400000,
      '1d': 86400000,
    };
    return map[interval] || 60000;
  }

  /**
   * Gets current ticker price
   */
  async getTickerPrice(symbol: string): Promise<number> {
    logger.debug(`Fetching ticker price for ${symbol}`);

    return this.retryWithBackoff(async () => {
      const coin = this.toOrderBookSymbol(symbol);
      const l2Book = await this.sdk.info.getL2Book(coin);

      const bids = l2Book?.levels?.[0] || [];
      const asks = l2Book?.levels?.[1] || [];

      if (bids.length === 0 || asks.length === 0) {
        throw new Error('Invalid order book data');
      }

      const bidPrice = parseFloat(bids[0].px);
      const askPrice = parseFloat(asks[0].px);
      const midPrice = (bidPrice + askPrice) / 2;

      return midPrice;
    });
  }

  /**
   * Gets order book data for analysis
   */
  async getOrderBook(
    symbol: string,
    depth: number = 20
  ): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
    logger.debug(`Fetching order book for ${symbol} (depth: ${depth})`);

    return this.retryWithBackoff(async () => {
      const coin = this.toOrderBookSymbol(symbol);
      const l2Book = await this.sdk.info.getL2Book(coin);

      const rawBids = l2Book?.levels?.[0] || [];
      const rawAsks = l2Book?.levels?.[1] || [];

      if (rawBids.length === 0 || rawAsks.length === 0) {
        logger.warn(`Empty order book for ${symbol}`);
        return null;
      }

      // Parse and limit to depth
      const bids = rawBids.slice(0, depth).map((level: any) => ({
        price: parseFloat(level.px),
        size: parseFloat(level.sz),
      }));

      const asks = rawAsks.slice(0, depth).map((level: any) => ({
        price: parseFloat(level.px),
        size: parseFloat(level.sz),
      }));

      logger.debug(`Order book fetched: ${bids.length} bids, ${asks.length} asks`);

      return { bids, asks };
    });
  }

  /**
   * Cancels an open order
   */
  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    logger.info(`Cancelling order ${orderId} for ${symbol}`);

    if (config.system.dryRun) {
      logger.warn('DRY RUN MODE: Order cancellation simulated');
      return true;
    }

    return this.retryWithBackoff(async () => {
      const coin = this.normalizeSymbol(symbol);
      await this.sdk.exchange.cancelOrder({
        coin,
        o: parseInt(orderId),
      });

      return true;
    });
  }

  /**
   * Closes a position by placing a market order in the opposite direction
   */
  async closePosition(symbol: string, size: number, side: 'long' | 'short'): Promise<OrderResponse> {
    logger.info(`Closing ${side} position for ${size} ${symbol}`);

    // To close a long position, we sell
    // To close a short position, we buy
    const orderSide = side === 'long' ? 'sell' : 'buy';

    // Use market order (Ioc limit) to close immediately
    return this.placeOrder(symbol, orderSide, size);
  }
}

// Export singleton instance
export const hyperliquidService = new HyperliquidService();
export default hyperliquidService;
