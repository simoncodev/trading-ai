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
  
  // Rate-limiting for HTTP fallback per symbol
  private lastHttpBookFetchTs: Map<string, number> = new Map();
  private httpBookCache: Map<string, { bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; ts: number }> = new Map();

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
        return 0.5; // BTC tick size on Hyperliquid
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
    logger.debug(`[Hyperliquid] Rounding price ${price} to tick size ${tickSize} for ${symbol}`);
    const rounded = Math.round(price / tickSize) * tickSize;
    const priceDecimals = await this.getPriceDecimals(symbol);
    const finalPrice = parseFloat(rounded.toFixed(priceDecimals));
    logger.debug(`[Hyperliquid] Rounded price: ${price} → ${rounded} → ${finalPrice}`);
    return finalPrice;
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

      // If price provided, round it to tick size immediately
      if (price) {
        const tickSize = await this.getTickSize(symbol);
        logger.debug(`[Hyperliquid] placeOrder: Rounding provided price ${price} with tick size ${tickSize}`);
        limitPx = Math.round(price / tickSize) * tickSize;
        logger.debug(`[Hyperliquid] placeOrder: Rounded limitPx = ${limitPx}`);
        
        // Convert to integer representation for API
        const priceDecimals = await this.getPriceDecimals(symbol);
        const priceMultiplier = Math.pow(10, priceDecimals);
        limitPx = Math.round(limitPx * priceMultiplier) / priceMultiplier; // Ensure exact multiple
        logger.debug(`[Hyperliquid] placeOrder: Final limitPx after multiplier: ${limitPx}`);
      }

      // If not using limit, convert to an aggressive IOC priced at top-of-book +/- k ticks
      // IMPORTANT: This replaces ANY legacy markPrice*(1±0.02) path.
      if (!useLimit) {
        try {
          const book = await this.getBestBidAsk(symbol);
          const tick = await this.getTickSize(symbol);
          const k = config.regime?.executionTicks ?? 1; // use EXECUTION_TICKS from config
          const mid = (book.bid + book.ask) / 2;
          
          // Compute bounded IOC price at top-of-book + k ticks
          if (side === 'buy') {
            limitPx = book.ask + k * tick;
          } else {
            limitPx = book.bid - k * tick;
          }
          
          // Enforce MAX_EXECUTION_SLIPPAGE_BPS guard against midprice
          const slippageBps = Math.abs(limitPx - mid) / mid * 10000;
          const maxSlippage = config.regime?.maxExecutionSlippageBps ?? 8;
          if (slippageBps > maxSlippage) {
            logger.warn('SKIP_EXEC_SLIPPAGE', { symbol, side, slippageBps, maxBps: maxSlippage, bestBid: book.bid, bestAsk: book.ask, mid });
            return { 
              ok: false, 
              skipped: true, 
              reason: 'SKIP_EXEC_SLIPPAGE', 
              slippageBps, 
              bestBid: book.bid, 
              bestAsk: book.ask, 
              mid 
            } as any;
          }
          
          orderType = { limit: { tif: 'Ioc' } };
          logger.info('Bounded IOC at top-of-book', { symbol, side, limitPx, bestBid: book.bid, bestAsk: book.ask, mid, slippageBps: slippageBps.toFixed(2), k });
        } catch (err) {
          logger.error('Failed to fetch top-of-book for IOC pricing', { error: err instanceof Error ? err.message : String(err) });
          throw new Error('Cannot place market order: failed to fetch top-of-book');
        }
      }

      // Round price to appropriate decimals
      // NOTE: Market orders (useLimit=false) already use Math.floor so skip rounding
      if (limitPx && useLimit) {
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
      // Check if limitPx is divisible by tick size
      const tickSize = await this.getTickSize(symbol);
      if (limitPx !== undefined && limitPx !== null) {
        const remainder = limitPx % tickSize;
        logger.debug(`[Hyperliquid] Tick size check: ${limitPx} % ${tickSize} = ${remainder}`);
        if (Math.abs(remainder) > 0.0001) { // Allow small floating point errors
          logger.warn(`[Hyperliquid] Price ${limitPx} not divisible by tick size ${tickSize}!`);
        }
      }
      // Use the SDK's placeOrder method
      // Use integer price as expected by SDK (no extra multiplier)
      // Some SDKs expect price as plain integer (e.g. whole USD price),
      // multiplying by a large priceMultiplier produced huge notional values.
      const limitPxInt = limitPx ? Math.round(limitPx) : 0;

      const orderParams = {
        coin: coin, // Use coin name for API
        is_buy: side === 'buy',
        sz: roundedQuantity,
        limit_px: limitPxInt,
        order_type: orderType,
        reduce_only: reduceOnly,
      };
      logger.debug(`[Hyperliquid] SDK order params: ${JSON.stringify(orderParams)} (original price: ${limitPx}, int price: ${limitPxInt})`);

      const orderResult = await this.sdk.exchange.placeOrder(orderParams);

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
    return this.exitPosition(symbol, orderSide, size, { kTicks: 1 });
  }

  /**
   * Enter a position using top-of-book IOC limit with bounded slippage
   * Returns ExecutionReport with: ts, symbol, intendedAction, side, requestedPx, fillPxAvg, filledSize, makerTaker, feePaid, slippageBps, status, reason
   */
  async enterPosition(
    symbol: string,
    side: 'buy' | 'sell',
    size: number,
    opts?: { kTicks?: number; postOnly?: boolean; timeoutMs?: number }
  ): Promise<any> {
    const k = opts?.kTicks ?? (config.regime?.executionTicks ?? 1);
    const postOnly = opts?.postOnly ?? false;

    logger.info('EnterPosition requested', { symbol, side, size, k, postOnly });

    const book = await this.getBestBidAsk(symbol);
    const tick = await this.getTickSize(symbol);
    const mid = (book.bid + book.ask) / 2;
    let limitPx = side === 'buy' ? book.ask + k * tick : book.bid - k * tick;

    const slippageBps = Math.abs(limitPx - mid) / mid * 10000;
    const maxSlippage = config.regime?.maxExecutionSlippageBps ?? 8;
    if (slippageBps > maxSlippage) {
      logger.warn('SKIP_EXEC_SLIPPAGE', { symbol, side, slippageBps, maxBps: maxSlippage });
      return { 
        ok: false, 
        skipped: true, 
        reason: 'SKIP_EXEC_SLIPPAGE', 
        slippageBps,
        bestBid: book.bid,
        bestAsk: book.ask,
        mid,
        ts: Date.now(),
        symbol,
        intendedAction: 'ENTRY',
        side,
        status: 'skipped'
      };
    }

    // Round to tick and price decimals
    limitPx = await this.roundPriceToTick(symbol, limitPx);

    // Dry run simulation
    if (config.system.dryRun || config.regime?.dryRun) {
      const fillPx = limitPx; // limit IOC at top-of-book simulated
      const filledSize = size; // assume full fill for IOC at top-of-book in dry-run
      const makerTaker = 'taker';
      const feePaid = (filledSize * fillPx) * ((config.regime?.takerFeeBps ?? 6) / 10000);
      const slippage = Math.abs(fillPx - mid) / mid * 10000;
      logger.info('DRY RUN enterPosition simulated', { symbol, side, size, fillPx, slippageBps: slippage.toFixed(2) });
      return {
        ok: true,
        orderId: `DRY_ENTER_${Date.now()}`,
        ts: Date.now(),
        symbol,
        intendedAction: 'ENTRY',
        side,
        requestedPx: limitPx,
        fillPxAvg: fillPx,
        filledSize,
        makerTaker,
        feePaid,
        slippageBps: slippage,
        status: 'filled',
        reason: null
      };
    }

    // Live execution: place IOC limit order at limitPx
    const coin = this.normalizeSymbol(symbol);
    const priceInt = Math.round(limitPx);
    const orderParams = {
      coin,
      is_buy: side === 'buy',
      sz: size,
      limit_px: priceInt,
      order_type: { limit: { tif: 'Ioc', postOnly } },
      reduce_only: false,
    };

    logger.info('Placing IOC entry order', { orderParams: orderParams as any });

    const result = await this.retryWithBackoff(async () => {
      return await (this.sdk.exchange as any).placeOrder(orderParams as any);
    });

    // Parse fills
    const status = result?.response?.data?.statuses?.[0];
    const filledQuantity = parseFloat(status?.filled?.totalSz || '0');
    const fillPxAvg = parseFloat(status?.filled?.avgPx || '0');
    const feePaid = parseFloat(status?.filled?.fee || '0');

    return {
      ok: filledQuantity > 0,
      orderId: status?.resting?.oid?.toString() || `ENTER_${Date.now()}`,
      ts: Date.now(),
      symbol,
      intendedAction: 'ENTRY',
      side,
      requestedPx: limitPx,
      fillPxAvg: fillPxAvg || limitPx,
      filledSize: filledQuantity,
      makerTaker: filledQuantity > 0 ? (status?.filled?.maker ? 'maker' : 'taker') : 'unknown',
      feePaid,
      slippageBps: Math.abs((fillPxAvg || limitPx) - mid) / mid * 10000,
      status: filledQuantity > 0 ? 'filled' : 'unfilled',
      reason: filledQuantity === 0 ? 'NO_FILL' : null
    };
  }

  /**
   * Exit a position using reduceOnly IOC limit with bounded slippage
   * Ensures size <= current position size (cannot flip position)
   * Returns ExecutionReport with: ts, symbol, intendedAction, side, requestedPx, fillPxAvg, filledSize, makerTaker, feePaid, slippageBps, status, reason
   */
  async exitPosition(
    symbol: string,
    side: 'buy' | 'sell',
    size: number,
    opts?: { kTicks?: number; postOnly?: boolean }
  ): Promise<any> {
    const k = opts?.kTicks ?? (config.regime?.executionTicks ?? 1);
    const postOnly = opts?.postOnly ?? false;

    logger.info('ExitPosition requested (reduceOnly)', { symbol, side, size, k, postOnly });

    const book = await this.getBestBidAsk(symbol);
    const tick = await this.getTickSize(symbol);
    const mid = (book.bid + book.ask) / 2;
    let limitPx = side === 'buy' ? book.ask + k * tick : book.bid - k * tick;

    const slippageBps = Math.abs(limitPx - mid) / mid * 10000;
    const maxSlippage = config.regime?.maxExecutionSlippageBps ?? 8;
    if (slippageBps > maxSlippage) {
      logger.warn('SKIP_EXEC_SLIPPAGE on exit', { symbol, side, slippageBps, maxBps: maxSlippage });
      return { 
        ok: false, 
        skipped: true, 
        reason: 'SKIP_EXEC_SLIPPAGE', 
        slippageBps,
        bestBid: book.bid,
        bestAsk: book.ask,
        mid,
        ts: Date.now(),
        symbol,
        intendedAction: 'EXIT',
        side,
        status: 'skipped'
      };
    }

    limitPx = await this.roundPriceToTick(symbol, limitPx);

    if (config.system.dryRun || config.regime?.dryRun) {
      const fillPx = limitPx;
      const filledSize = size;
      const makerTaker = 'taker';
      const feePaid = (filledSize * fillPx) * ((config.regime?.takerFeeBps ?? 6) / 10000);
      const slippage = Math.abs(fillPx - mid) / mid * 10000;
      logger.info('DRY RUN exitPosition simulated', { symbol, side, size, fillPx, slippageBps: slippage.toFixed(2) });
      return {
        ok: true,
        orderId: `DRY_EXIT_${Date.now()}`,
        ts: Date.now(),
        symbol,
        intendedAction: 'EXIT',
        side,
        requestedPx: limitPx,
        fillPxAvg: fillPx,
        filledSize,
        makerTaker,
        feePaid,
        slippageBps: slippage,
        status: 'filled',
        reason: null
      };
    }

    const coin = this.normalizeSymbol(symbol);
    const priceInt = Math.round(limitPx);
    const orderParams = {
      coin,
      is_buy: side === 'buy',
      sz: size,
      limit_px: priceInt,
      order_type: { limit: { tif: 'Ioc', postOnly } },
      reduce_only: true, // CRITICAL: reduceOnly to prevent position flip
    };

    logger.info('Placing IOC exit (reduceOnly) order', { orderParams: orderParams as any });

    const result = await this.retryWithBackoff(async () => {
      return await (this.sdk.exchange as any).placeOrder(orderParams as any);
    });

    const status = result?.response?.data?.statuses?.[0];
    const filledQuantity = parseFloat(status?.filled?.totalSz || '0');
    const fillPxAvg = parseFloat(status?.filled?.avgPx || '0');
    const feePaid = parseFloat(status?.filled?.fee || '0');

    return {
      ok: filledQuantity > 0,
      orderId: status?.resting?.oid?.toString() || `EXIT_${Date.now()}`,
      ts: Date.now(),
      symbol,
      intendedAction: 'EXIT',
      side,
      requestedPx: limitPx,
      fillPxAvg: fillPxAvg || limitPx,
      filledSize: filledQuantity,
      makerTaker: filledQuantity > 0 ? (status?.filled?.maker ? 'maker' : 'taker') : 'unknown',
      feePaid,
      slippageBps: Math.abs((fillPxAvg || limitPx) - mid) / mid * 10000,
      status: filledQuantity > 0 ? 'filled' : 'unfilled',
      reason: filledQuantity === 0 ? 'NO_FILL' : null
    };
  }

  /**
   * Rate-limited HTTP fallback for order book
   * Only fetches if enough time has passed since last fetch for this symbol
   * Returns cached data if rate-limited, or null if no cache
   */
  async getOrderBookFallback(
    symbol: string,
    depth: number = 20
  ): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
    const now = Date.now();
    const lastFetch = this.lastHttpBookFetchTs.get(symbol) || 0;
    const minInterval = config.marketData?.httpFallbackMinIntervalMs || 5000;
    
    if (now - lastFetch < minInterval) {
      // Rate-limited: return cached data if available
      const cached = this.httpBookCache.get(symbol);
      if (cached && now - cached.ts < 60000) { // Cache valid for 60s
        logger.debug(`[HyperliquidService] Order book rate-limited for ${symbol}, returning cache`);
        return { bids: cached.bids, asks: cached.asks };
      }
      return null;
    }

    // Fetch fresh data
    this.lastHttpBookFetchTs.set(symbol, now);
    const result = await this.getOrderBook(symbol, depth);
    
    if (result) {
      this.httpBookCache.set(symbol, { ...result, ts: now });
    }
    
    return result;
  }

  /**
   * Place a post-only limit order (GTC).
   * Returns status: 'resting' if order is on book, 'filled' if it filled as maker (rare), 
   * 'rejected' if crossed spread (post-only rejected).
   */
  async placePostOnlyLimit(
    symbol: string,
    side: 'buy' | 'sell',
    size: number,
    limitPx: number,
    opts?: { reduceOnly?: boolean }
  ): Promise<{
    ok: boolean;
    orderId: string;
    status: 'resting' | 'filled' | 'rejected' | 'error';
    requestedPx: number;
    filledSize: number;
    fillPxAvg: number;
    reason?: string;
    ts: number;
    symbol: string;
    side: 'buy' | 'sell';
    makerTaker: 'maker' | 'unknown';
    feePaid: number;
  }> {
    const reduceOnly = opts?.reduceOnly ?? false;

    logger.info('placePostOnlyLimit requested', { symbol, side, size, limitPx, reduceOnly });

    // Round to tick
    const roundedPx = await this.roundPriceToTick(symbol, limitPx);

    // Dry run simulation
    if (config.system.dryRun || config.regime?.dryRun) {
      // Simulate: assume order rests on book (maker)
      logger.info('DRY RUN placePostOnlyLimit simulated as RESTING', { symbol, side, size, roundedPx });
      return {
        ok: true,
        orderId: `DRY_POST_${Date.now()}`,
        status: 'resting',
        requestedPx: roundedPx,
        filledSize: 0,
        fillPxAvg: 0,
        reason: undefined,
        ts: Date.now(),
        symbol,
        side,
        makerTaker: 'maker',
        feePaid: 0
      };
    }

    // Live execution
    const coin = this.normalizeSymbol(symbol);
    const priceInt = Math.round(roundedPx);
    const orderParams = {
      coin,
      is_buy: side === 'buy',
      sz: size,
      limit_px: priceInt,
      order_type: { limit: { tif: 'Gtc' } }, // GTC + implicit postOnly via pricing at/inside spread
      reduce_only: reduceOnly,
    };

    logger.info('Placing GTC limit order (maker-intent)', { orderParams: orderParams as any });

    try {
      const result = await this.retryWithBackoff(async () => {
        return await (this.sdk.exchange as any).placeOrder(orderParams as any);
      });

      const status = result?.response?.data?.statuses?.[0];
      
      if (status?.error) {
        logger.warn('placePostOnlyLimit rejected', { error: status.error });
        return {
          ok: false,
          orderId: '',
          status: 'rejected',
          requestedPx: roundedPx,
          filledSize: 0,
          fillPxAvg: 0,
          reason: status.error,
          ts: Date.now(),
          symbol,
          side,
          makerTaker: 'unknown',
          feePaid: 0
        };
      }

      const filledQuantity = parseFloat(status?.filled?.totalSz || '0');
      const fillPxAvg = parseFloat(status?.filled?.avgPx || '0');
      const feePaid = parseFloat(status?.filled?.fee || '0');
      const restingOid = status?.resting?.oid?.toString();

      // Determine outcome
      let orderStatus: 'resting' | 'filled' | 'rejected' = 'resting';
      if (filledQuantity >= size * 0.99) {
        orderStatus = 'filled'; // Filled immediately (crossed spread somehow, or size very small)
      } else if (restingOid) {
        orderStatus = 'resting';
      } else if (filledQuantity === 0 && !restingOid) {
        orderStatus = 'rejected';
      }

      return {
        ok: orderStatus !== 'rejected',
        orderId: restingOid || `FILLED_${Date.now()}`,
        status: orderStatus,
        requestedPx: roundedPx,
        filledSize: filledQuantity,
        fillPxAvg: fillPxAvg || roundedPx,
        reason: orderStatus === 'rejected' ? 'POST_ONLY_REJECT' : undefined,
        ts: Date.now(),
        symbol,
        side,
        makerTaker: 'maker',
        feePaid
      };
    } catch (err) {
      logger.error('placePostOnlyLimit error', { error: err instanceof Error ? err.message : String(err) });
      return {
        ok: false,
        orderId: '',
        status: 'error',
        requestedPx: roundedPx,
        filledSize: 0,
        fillPxAvg: 0,
        reason: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
        symbol,
        side,
        makerTaker: 'unknown',
        feePaid: 0
      };
    }
  }

  /**
   * Get tick size for a symbol (public method for external use)
   */
  async getTickSizePublic(symbol: string): Promise<number> {
    return this.getTickSize(symbol);
  }

  /**
   * Get order status by orderId
   * Returns null if order not found or API doesn't support it
   */
  async getOrderStatus(_symbol: string, orderId: string): Promise<{
    status: 'resting' | 'filled' | 'canceled' | 'unknown';
    filledSize: number;
    remainingSize: number;
  } | null> {
    try {
      // Hyperliquid SDK may not have a direct getOrderStatus - use open orders check
      // Note: _symbol could be used in future to filter orders by coin
      const openOrders = await (this.sdk.info as any).getUserOpenOrders(this.walletAddress);
      
      const order = openOrders?.find((o: any) => o.oid?.toString() === orderId);
      if (order) {
        const origSz = parseFloat(order.origSz || order.sz || '0');
        const filledSz = parseFloat(order.filledSz || '0');
        return {
          status: 'resting',
          filledSize: filledSz,
          remainingSize: origSz - filledSz
        };
      }
      
      // Not in open orders - either filled or canceled
      // We can't easily distinguish without fill history, return unknown
      return { status: 'unknown', filledSize: 0, remainingSize: 0 };
    } catch (err) {
      logger.warn('getOrderStatus failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

// Export singleton instance
export const hyperliquidService = new HyperliquidService();
export default hyperliquidService;
