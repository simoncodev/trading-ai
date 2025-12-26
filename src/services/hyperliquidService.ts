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
  private masterAddress: string;

  constructor() {
    // Get configuration
    const privateKey = config.hyperliquid.secret;
    this.walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS || '';
    this.masterAddress = config.hyperliquid.walletAddress || this.walletAddress;
    
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
    logger.info(`Agent Address: ${this.walletAddress}`);
    logger.info(`Master Address: ${this.masterAddress}`);
  }

  private metaCache: any = null;
  private lastMetaFetch: number = 0;
  private readonly META_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  private async getMeta() {
    if (this.metaCache && Date.now() - this.lastMetaFetch < this.META_CACHE_TTL) {
      return this.metaCache;
    }
    this.metaCache = await this.sdk.info.perpetuals.getMeta();
    this.lastMetaFetch = Date.now();
    return this.metaCache;
  }

  private async getAssetIndex(symbol: string): Promise<number> {
    try {
      const meta = await this.getMeta();
      const coin = this.normalizeSymbol(symbol);
      const assetIndex = meta.universe.findIndex((u: any) => u.name === coin);
      if (assetIndex === -1) {
        throw new Error(`Asset ${coin} not found in universe`);
      }
      return assetIndex;
    } catch (error) {
      logger.error('Failed to get asset index', { symbol, error: error instanceof Error ? error.message : String(error) });
      // Fallback: try to map common assets
      const coin = this.normalizeSymbol(symbol);
      const commonAssets: Record<string, number> = {
        'BTC-PERP': 0,
        'ETH-PERP': 1,
        'SOL': 2,
        'ARB': 3,
        'OP': 4,
        'MATIC': 5,
        'AVAX': 6,
        'LINK': 7,
        'UNI': 8,
        'AAVE': 9,
        'SUSHI': 10,
        'CRV': 11,
        'COMP': 12,
        'MKR': 13,
        'YFI': 14,
        'BAL': 15,
        'REN': 16,
        'KNC': 17,
        'ZRX': 18,
        'BAT': 19,
        'OMG': 20,
        'LRC': 21,
        'REP': 22,
        'GNT': 23,
        'STORJ': 24,
        'ANT': 25,
        'WAVES': 26,
        'LSK': 27,
        'ARK': 28,
        'STRAT': 29,
        'XEM': 30,
        'QTUM': 31,
        'BTG': 32,
        'ZEC': 33,
        'DASH': 34,
        'XMR': 35,
        'ETC': 36,
        'DOGE': 37,
        'LTC': 38,
        'XRP': 39,
        'ADA': 40,
        'DOT': 41,
        'TRX': 42,
        'EOS': 43,
        'BCH': 44,
        'BSV': 45,
        'XLM': 46,
        'ALGO': 47,
        'VET': 48,
        'ICP': 49,
        'FIL': 50,
        'THETA': 51,
        'HBAR': 52,
        'NEAR': 53,
        'FLOW': 54,
        'MANA': 55,
        'SAND': 56,
        'AXS': 57,
        'ENJ': 58,
        'CHZ': 59,
        'APE': 60,
        'GAL': 61,
        'LDO': 62,
        'GMT': 63,
        'JASMY': 64,
        'DAR': 65,
        'IMX': 66,
        'APEX': 67,
        'FTM': 68,
        'GALA': 69,
      };
      return commonAssets[coin] ?? 0; // Default to 0 (BTC) if not found
    }
  }



  private async getPrecision(symbol: string): Promise<number> {
    try {
      const meta = await this.getMeta();
      const baseAsset = symbol.split('-')[0];
      const assetInfo = meta.universe.find((u: any) => u.name === baseAsset);
      return assetInfo ? assetInfo.szDecimals : 4;
    } catch (error) {
      logger.warn('Failed to fetch meta for precision, defaulting to 4', { error: error instanceof Error ? error.message : String(error) });
      return 4;
    }
  }

  private async getTickSize(symbol: string): Promise<number> {
    // Use conservative tick sizes for crypto perpetuals
    const baseAsset = symbol.split('-')[0];
    switch (baseAsset) {
      case 'BTC':
        return 0.5; // BTC typically has 0.5 tick size
      case 'ETH':
        return 0.01; // ETH typically has 0.01 tick size
      default:
        return 0.01; // Default conservative tick size
    }
  }

  private async getPriceDecimals(symbol: string): Promise<number> {
    try {
      const meta = await this.getMeta();
      const baseAsset = symbol.split('-')[0];
      const assetInfo = meta.universe.find((u: any) => u.name === baseAsset);
      // Price decimals are typically szDecimals + 1 or fixed at 5 for crypto
      return assetInfo ? Math.max(assetInfo.szDecimals + 1, 5) : 5;
    } catch (error) {
      logger.warn('Failed to fetch price decimals, defaulting to 5', { error: error instanceof Error ? error.message : String(error) });
      return 5;
    }
  }
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
   * DenormalizeSymbol da Hyperliquid al formato interno
   * BTC-PERP -> BTC-USDC
   */
  private denormalizeSymbol(symbol: string): string {
    const baseAsset = symbol.split('-')[0];
    return `${baseAsset}-USDC`;
  }

  /**
   * Sets leverage for a specific symbol
   */
  async setLeverage(symbol: string, leverage: number, isCross: boolean = false): Promise<any> {
    logger.info(`Setting leverage to ${leverage}x for ${symbol} (Cross: ${isCross})`);

    if (config.system.dryRun) {
      logger.warn('DRY RUN MODE: Leverage update simulated');
      return { status: 'ok' };
    }

    return this.retryWithBackoff(async () => {
      const coin = this.normalizeSymbol(symbol);
      const mode = isCross ? 'cross' : 'isolated';
      // @ts-ignore - SDK types might be incomplete
      return await this.sdk.exchange.updateLeverage(coin, mode, leverage);
    });
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
    const targetAddress = this.masterAddress || this.walletAddress;
    logger.info('Fetching account information for address: ' + targetAddress);

    return this.retryWithBackoff(async () => {
      const clearinghouseState = await this.sdk.info.perpetuals.getClearinghouseState(targetAddress);

      const marginSummary = clearinghouseState.marginSummary;
      const assetPositions = clearinghouseState.assetPositions || [];

      logger.info('Raw margin summary', { marginSummary: JSON.stringify(marginSummary) });

      // Calcola P&L totale dalle posizioni
      const positions = assetPositions.map((pos: any) => ({
        symbol: this.denormalizeSymbol(pos.position.coin),
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
   * Round price to valid tick size
   */
  async roundPriceToTick(symbol: string, price: number): Promise<number> {
    const tickSize = await this.getTickSize(symbol);
    const rounded = Math.round(price / tickSize) * tickSize;
    const priceDecimals = await this.getPriceDecimals(symbol);
    return parseFloat(rounded.toFixed(priceDecimals));
  }

  /**
   * Get minimum order size for an asset
   */
  async getMinOrderSize(symbol: string): Promise<number> {
    try {
      const meta = await this.getMeta();
      const baseAsset = symbol.split('-')[0];
      const assetInfo = meta.universe.find((u: any) => u.name === baseAsset);
      return assetInfo ? Math.pow(10, -assetInfo.szDecimals) : 0.001;
    } catch (error) {
      logger.warn('Failed to fetch min order size, defaulting to 0.001', { error: error instanceof Error ? error.message : String(error) });
      return 0.001;
    }
  }
  async getBestBidAsk(symbol: string): Promise<{ bid: number; ask: number; spread: number }> {
    const coin = this.toOrderBookSymbol(symbol);
    const l2Book = await this.sdk.info.getL2Book(coin);

    const bids = l2Book?.levels?.[0] || [];
    const asks = l2Book?.levels?.[1] || [];

    if (bids.length === 0 || asks.length === 0) {
      throw new Error('Invalid order book data');
    }

    const bid = parseFloat(bids[0].px);
    const ask = parseFloat(asks[0].px);
    const spread = ((ask - bid) / bid) * 100;

    return { bid, ask, spread };
  }

  /**
   * Places an order on Hyperliquid
   * @param useLimit - If true, uses LIMIT order at bid/ask for better fills
   */
  async placeOrder(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price?: number,
    useLimit: boolean = true,
    reduceOnly: boolean = false
  ): Promise<OrderResponse> {
    logger.info(`Placing ${side} ${useLimit ? 'LIMIT' : 'MARKET'} order for ${quantity} ${symbol}`, {
      symbol,
      side,
      quantity,
      price,
      useLimit,
      reduceOnly
    });

    // Dry run mode - REALISTIC SIMULATION FOR LIMIT ORDERS
    if (config.system.dryRun) {
      // Simulate network latency (30-80ms - Hyperliquid is fast)
      const latency = 30 + Math.random() * 50;
      await new Promise(resolve => setTimeout(resolve, latency));
      
      // For LIMIT orders: NO slippage, fill at requested price
      // For MARKET orders: small slippage
      let filledPrice = price || 0;
      let makerFee = true;
      
      if (!useLimit) {
        // Market order - small slippage against you
        const slippagePercent = 0.0001 + Math.random() * 0.0001; // 0.01% - 0.02%
        const slippageDirection = side === 'buy' ? 1 : -1;
        filledPrice = (price || 0) * (1 + slippageDirection * slippagePercent);
        makerFee = false;
      }
      
      // Simulate fills (98-100% for limit orders that cross spread)
      const fillRate = 0.98 + Math.random() * 0.02;
      const filledQty = quantity * fillRate;
      
      // LIMIT orders get MAKER fee (0.02%), MARKET orders get TAKER fee (0.035%)
      const notionalValue = filledQty * filledPrice;
      const feeRate = makerFee ? 0.0002 : 0.00035; // 0.02% maker vs 0.035% taker
      const estimatedFee = notionalValue * feeRate;
      
      logger.warn('DRY RUN MODE: LIMIT order simulation', {
        orderType: useLimit ? 'LIMIT' : 'MARKET',
        latencyMs: latency.toFixed(0),
        requestedPrice: price?.toFixed(2),
        filledPrice: filledPrice.toFixed(2),
        fillRate: (fillRate * 100).toFixed(1) + '%',
        feeType: makerFee ? 'MAKER 0.02%' : 'TAKER 0.035%',
        fee: estimatedFee.toFixed(4),
      });
      
      return {
        orderId: `DRY_RUN_${Date.now()}`,
        symbol,
        side,
        type: useLimit ? 'limit' : 'market',
        quantity: filledQty,
        price: filledPrice, // No slippage for LIMIT orders
        status: 'filled',
        filledQuantity: filledQty,
        timestamp: Date.now(),
        fee: estimatedFee,
      };
    }

    return this.retryWithBackoff(async () => {
      const coin = this.normalizeSymbol(symbol);
      const assetIndex = await this.getAssetIndex(symbol);
      
      // Get precision and round quantity
      const precision = await this.getPrecision(symbol);
      const roundedQuantity = parseFloat(quantity.toFixed(precision));
      
      if (roundedQuantity === 0) {
        throw new Error(`Quantity ${quantity} is too small for asset precision ${precision}`);
      }

      let limitPx = price;
      // Use 'any' to avoid TS issues with SDK types
      let orderType: any = { limit: { tif: 'Gtc' } };

      // If no price provided or not using limit, treat as MARKET order (IOC with aggressive price)
      if (!useLimit || !price) {
        try {
          const book = await this.getBestBidAsk(symbol);
          const slippage = 0.005; // 0.5% slippage tolerance for market orders
          
          if (side === 'buy') {
             // Buy: price must be higher than ask
             limitPx = book.ask * (1 + slippage);
          } else {
             // Sell: price must be lower than bid
             limitPx = book.bid * (1 - slippage);
          }
          
          orderType = { limit: { tif: 'Ioc' } };
          logger.info(`Market order converted to Limit IOC`, { symbol, side, limitPx, originalPrice: price });
        } catch (err) {
          logger.error('Failed to get orderbook for market order pricing', err);
          throw new Error('Cannot place market order: failed to fetch current price');
        }
      }

      // Round price to tick size to ensure divisibility
      if (limitPx) {
        // Get proper tick size based on asset
        const tickSize = await this.getTickSize(symbol);
        // Use proper rounding to avoid floating point issues
        limitPx = parseFloat((limitPx / tickSize).toFixed(0)) * tickSize;
        // Use appropriate decimals for price
        const priceDecimals = await this.getPriceDecimals(symbol);
        limitPx = parseFloat(limitPx.toFixed(priceDecimals));
      }

      logger.info(`Placing order on Hyperliquid`, {
        assetIndex,
        coin,
        is_buy: side === 'buy',
        sz: roundedQuantity,
        limit_px: limitPx,
        order_type: JSON.stringify(orderType)
      });

      // Use the SDK's placeOrder method
      const orderResult = await this.sdk.exchange.placeOrder({
        coin: coin, // Use coin name for API
        is_buy: side === 'buy',
        sz: roundedQuantity,
        limit_px: limitPx ? limitPx.toString() : '0',
        order_type: orderType,
        reduce_only: reduceOnly,
      });

      logger.info('Order result received', { orderResult: JSON.stringify(orderResult) });

      // Extract order info from response
      const status = orderResult?.response?.data?.statuses?.[0];
      
      logger.info('Order status', { status: JSON.stringify(status) });
      
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

    // Use market order (Ioc limit) to close immediately, with reduceOnly=true
    return this.placeOrder(symbol, orderSide, size, undefined, false, true);
  }
}

// Export singleton instance
export const hyperliquidService = new HyperliquidService();
export default hyperliquidService;
