import { hyperliquidService } from './hyperliquidService';
import { logger } from '../core/logger';
import { Candle } from '../types';
import { DEFAULTS } from '../utils/constants';

/**
 * Service for fetching and normalizing market data
 */
class MarketDataService {
  /**
   * Fetches OHLCV candle data for a symbol
   * Note: Sub-minute intervals (e.g., 10s, 15s) are normalized to 1m
   * because Hyperliquid API only supports minute+ intervals
   */
  async getCandles(
    symbol: string,
    interval: string,
    limit: number = DEFAULTS.CANDLE_LIMIT
  ): Promise<Candle[]> {
    try {
      // Normalize sub-minute intervals to 1m (Hyperliquid doesn't support seconds)
      const apiInterval = interval.endsWith('s') ? '1m' : interval;
      
      logger.debug(`Fetching candle data for ${symbol}`, { symbol, interval: apiInterval, limit });

      const candles = await hyperliquidService.getCandles(symbol, apiInterval, limit);

      if (!candles || candles.length === 0) {
        logger.warn(`No candle data received for ${symbol}`);
        return [];
      }

      // Sort candles by timestamp (ascending)
      const sortedCandles = candles.sort((a, b) => a.timestamp - b.timestamp);

      logger.debug(`Retrieved ${sortedCandles.length} candles for ${symbol}`);

      return sortedCandles;
    } catch (error) {
      logger.error(`Failed to fetch candles for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * Gets the latest price for a symbol
   */
  async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const price = await hyperliquidService.getTickerPrice(symbol);
      logger.debug(`Current price for ${symbol}: ${price}`);
      return price;
    } catch (error) {
      logger.error(`Failed to fetch current price for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * Fetches historical candles for backtesting
   */
  async getHistoricalCandles(
    symbol: string,
    interval: string,
    startDate: Date,
    endDate: Date
  ): Promise<Candle[]> {
    try {
      logger.info(`Fetching historical data for ${symbol} from ${startDate} to ${endDate}`);

      // Calculate number of candles needed
      const intervalMs = this.getIntervalMilliseconds(interval);
      const totalTime = endDate.getTime() - startDate.getTime();
      const estimatedCandles = Math.ceil(totalTime / intervalMs);

      logger.debug(`Estimated candles needed: ${estimatedCandles}`);

      // Fetch in batches if needed (Hyperliquid may have limits)
      const batchSize = 1000;
      const batches = Math.ceil(estimatedCandles / batchSize);
      let allCandles: Candle[] = [];

      for (let i = 0; i < batches; i++) {
        const batchCandles = await hyperliquidService.getCandles(
          symbol,
          interval,
          Math.min(batchSize, estimatedCandles - i * batchSize)
        );
        allCandles = allCandles.concat(batchCandles);
        
        logger.debug(`Fetched batch ${i + 1}/${batches} with ${batchCandles.length} candles`);
      }

      // Filter candles within date range
      const filteredCandles = allCandles.filter(
        (candle) =>
          candle.timestamp >= startDate.getTime() &&
          candle.timestamp <= endDate.getTime()
      );

      logger.info(`Retrieved ${filteredCandles.length} historical candles for ${symbol}`);

      return filteredCandles;
    } catch (error) {
      logger.error(`Failed to fetch historical data for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * Converts interval string to milliseconds
   */
  private getIntervalMilliseconds(interval: string): number {
    const units: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) {
      throw new Error(`Invalid interval format: ${interval}`);
    }

    const [, value, unit] = match;
    return parseInt(value) * units[unit];
  }

  /**
   * Normalizes candle data (handles missing values, outliers)
   */
  normalizeCandles(candles: Candle[]): Candle[] {
    return candles.map((candle, index) => {
      // Fill missing values with previous candle
      if (index > 0 && (candle.close === 0 || !candle.close)) {
        const prevCandle = candles[index - 1];
        return {
          ...candle,
          open: prevCandle.close,
          high: prevCandle.close,
          low: prevCandle.close,
          close: prevCandle.close,
        };
      }
      return candle;
    });
  }

  /**
   * Calculates market snapshot for current conditions
   */
  async getMarketSnapshot(symbol: string, interval: string): Promise<{
    currentPrice: number;
    recentCandles: Candle[];
    volume24h: number;
    priceChange24h: number;
    volatility: number;
  }> {
    const candles = await this.getCandles(symbol, interval, 100);
    const currentPrice = await this.getCurrentPrice(symbol);

    if (candles.length === 0) {
      throw new Error(`No candle data available for ${symbol}`);
    }

    // Calculate 24h metrics
    const last24hCandles = candles.slice(-24);
    const volume24h = last24hCandles.reduce((sum, c) => sum + c.volume, 0);
    const price24hAgo = last24hCandles[0]?.close || currentPrice;
    const priceChange24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

    // Calculate volatility (standard deviation of returns)
    const returns = candles.slice(-24).map((c, i, arr) => {
      if (i === 0) return 0;
      return (c.close - arr[i - 1].close) / arr[i - 1].close;
    });
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance) * 100;

    return {
      currentPrice,
      recentCandles: candles, // Return all candles for indicator calculation
      volume24h,
      priceChange24h,
      volatility,
    };
  }
}

// Export singleton instance
export const marketDataService = new MarketDataService();
export default marketDataService;
