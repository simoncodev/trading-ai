import {
  RSI,
  MACD,
  EMA,
  BollingerBands,
  SMA,
  ATR,
} from 'technicalindicators';
import { Candle, Indicators, MACDResult, BollingerBandsResult, MultiTimeframeIndicators } from '../types';
import { logger } from '../core/logger';
import { INDICATOR_CONSTANTS } from '../utils/constants';

/**
 * Service for calculating technical indicators
 */
class IndicatorService {
  /**
   * Calculates all technical indicators for given candles
   */
  async getIndicators(candles: Candle[], params?: {
    rsiPeriod?: number;
    emaFast?: number;
    emaSlow?: number;
    macdSignal?: number;
    bollingerPeriod?: number;
    bollingerStdDev?: number;
  }): Promise<Indicators> {
    // Ridotto a 50 per supportare asset con meno storico
    const minCandles = 50;
    if (candles.length < minCandles) {
      throw new Error(
        `Insufficient candle data for ${candles.length} candles. Need at least ${minCandles}`
      );
    }

    logger.debug('Calculating technical indicators', { candleCount: candles.length });

    // OTTIMIZZATI PER 1-MINUTE SCALPING (valori più reattivi)
    const rsiPeriod = params?.rsiPeriod || 7; // Ridotto da 14 per maggiore reattività
    const emaFast = params?.emaFast || 5; // Ridotto da 12 per scalping
    const emaSlow = params?.emaSlow || 13; // Ridotto da 26 per scalping
    const macdSignal = params?.macdSignal || 5; // Ridotto da 9 per segnali più veloci
    const bollingerPeriod = params?.bollingerPeriod || 10; // Ridotto da 20 per scalping
    const bollingerStdDev = params?.bollingerStdDev || 1.5; // Ridotto da 2 per bande più strette

    const closePrices = candles.map((c) => c.close);
    const highPrices = candles.map((c) => c.high);
    const lowPrices = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    try {
      // Calculate RSI
      const rsiValues = RSI.calculate({
        values: closePrices,
        period: rsiPeriod,
      });
      const rsi = rsiValues[rsiValues.length - 1] || 50;

      // Calculate MACD
      const macdValues = MACD.calculate({
        values: closePrices,
        fastPeriod: emaFast,
        slowPeriod: emaSlow,
        signalPeriod: macdSignal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      const lastMacd = macdValues[macdValues.length - 1];
      const macd: MACDResult = {
        macd: lastMacd?.MACD || 0,
        signal: lastMacd?.signal || 0,
        histogram: lastMacd?.histogram || 0,
      };

      // Calculate EMAs
      const ema12Values = EMA.calculate({
        values: closePrices,
        period: emaFast,
      });
      const ema12 = ema12Values[ema12Values.length - 1] || closePrices[closePrices.length - 1];

      const ema26Values = EMA.calculate({
        values: closePrices,
        period: emaSlow,
      });
      const ema26 = ema26Values[ema26Values.length - 1] || closePrices[closePrices.length - 1];

      // Calculate Bollinger Bands
      const bbValues = BollingerBands.calculate({
        values: closePrices,
        period: bollingerPeriod,
        stdDev: bollingerStdDev,
      });
      const lastBB = bbValues[bbValues.length - 1];
      const bollingerBands: BollingerBandsResult = {
        upper: lastBB?.upper || 0,
        middle: lastBB?.middle || 0,
        lower: lastBB?.lower || 0,
      };

      // Calculate SMA
      const smaValues = SMA.calculate({
        values: closePrices,
        period: bollingerPeriod,
      });
      const sma20 = smaValues[smaValues.length - 1] || closePrices[closePrices.length - 1];

      // Calculate ATR
      const atrValues = ATR.calculate({
        high: highPrices,
        low: lowPrices,
        close: closePrices,
        period: 14,
      });
      const atr = atrValues[atrValues.length - 1] || 0;

      // Calculate volume average
      const volumeAverage =
        volumes.slice(-20).reduce((sum, v) => sum + v, 0) / Math.min(20, volumes.length);

      const indicators: Indicators = {
        rsi,
        macd,
        ema12,
        ema26,
        bollingerBands,
        sma20,
        atr,
        volumeAverage,
      };

      logger.debug('Indicators calculated', {
        rsi: rsi.toFixed(2),
        macd: macd.macd.toFixed(4),
        ema12: ema12.toFixed(2),
        ema26: ema26.toFixed(2),
      });

      return indicators;
    } catch (error) {
      logger.error('Failed to calculate indicators', error);
      throw error;
    }
  }

  /**
   * Calculates multi-timeframe indicators for advanced AI analysis
   * This gives the AI multiple perspectives to make better decisions
   */
  async getMultiTimeframeIndicators(candles: Candle[], currentPrice: number): Promise<MultiTimeframeIndicators> {
    const minCandles = 60;
    if (candles.length < minCandles) {
      throw new Error(`Insufficient candle data: ${candles.length}. Need at least ${minCandles}`);
    }

    const closePrices = candles.map((c) => c.close);
    const highPrices = candles.map((c) => c.high);
    const lowPrices = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const currentVolume = volumes[volumes.length - 1];

    try {
      // ==================== RSI Multi-Period ====================
      const rsiShort = this.calculateRSI(closePrices, 7);
      const rsiMedium = this.calculateRSI(closePrices, 14);
      const rsiLong = this.calculateRSI(closePrices, 21);

      // ==================== EMA Multi-Timeframe ====================
      const ema5 = this.calculateEMA(closePrices, 5);
      const ema13 = this.calculateEMA(closePrices, 13);
      const ema12 = this.calculateEMA(closePrices, 12);
      const ema26 = this.calculateEMA(closePrices, 26);
      const ema20 = this.calculateEMA(closePrices, 20);
      const ema50 = this.calculateEMA(closePrices, 50);

      const emaTrendScalping = this.determineEMATrend(ema5, ema13);
      const emaTrendStandard = this.determineEMATrend(ema12, ema26);
      const emaTrendSwing = this.determineEMATrend(ema20, ema50);

      // ==================== MACD Multi-Setting ====================
      const macdFast = this.calculateMACD(closePrices, 5, 13, 5);
      const macdStandard = this.calculateMACD(closePrices, 12, 26, 9);

      // ==================== Bollinger Bands Multi-Setting ====================
      const bbTight = this.calculateBollingerBands(closePrices, 10, 1.5);
      const bbStandard = this.calculateBollingerBands(closePrices, 20, 2);

      // ==================== ATR Multi-Period ====================
      const atrShort = this.calculateATR(highPrices, lowPrices, closePrices, 7);
      const atrMedium = this.calculateATR(highPrices, lowPrices, closePrices, 14);

      // ==================== Volume Analysis ====================
      const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const avgVolume50 = volumes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, volumes.length);
      const volumeRatio = currentVolume / avgVolume20;

      // ==================== SMA Levels ====================
      const sma10 = this.calculateSMA(closePrices, 10);
      const sma20 = this.calculateSMA(closePrices, 20);
      const sma50 = this.calculateSMA(closePrices, 50);

      // ==================== Aggregated Signals ====================
      const signals = {
        rsiOversold: rsiShort < 30 || rsiMedium < 30,
        rsiOverbought: rsiShort > 70 || rsiMedium > 70,
        macdBullish: macdFast.histogram > 0 && macdStandard.histogram > 0,
        macdBearish: macdFast.histogram < 0 && macdStandard.histogram < 0,
        priceAboveEMA: currentPrice > ema20 && currentPrice > ema50,
        priceBelowEMA: currentPrice < ema20 && currentPrice < ema50,
        highVolume: volumeRatio > 1.5,
        nearBBUpper: currentPrice >= bbStandard.upper * 0.995,
        nearBBLower: currentPrice <= bbStandard.lower * 1.005,
      };

      const result: MultiTimeframeIndicators = {
        rsi: {
          short: rsiShort,
          medium: rsiMedium,
          long: rsiLong,
        },
        ema: {
          scalping: { fast: ema5, slow: ema13, trend: emaTrendScalping },
          standard: { fast: ema12, slow: ema26, trend: emaTrendStandard },
          swing: { fast: ema20, slow: ema50, trend: emaTrendSwing },
        },
        macd: {
          fast: macdFast,
          standard: macdStandard,
        },
        bollingerBands: {
          tight: bbTight,
          standard: bbStandard,
        },
        atr: {
          short: atrShort,
          medium: atrMedium,
        },
        volume: {
          current: currentVolume,
          average20: avgVolume20,
          average50: avgVolume50,
          ratio: volumeRatio,
          isHigh: volumeRatio > 1.5,
        },
        sma: {
          sma10,
          sma20,
          sma50,
        },
        signals,
      };

      logger.debug('Multi-timeframe indicators calculated', {
        rsiShort: rsiShort.toFixed(2),
        rsiMedium: rsiMedium.toFixed(2),
        emaTrendScalping,
        emaTrendStandard,
        volumeRatio: volumeRatio.toFixed(2),
      });

      return result;
    } catch (error) {
      logger.error('Failed to calculate multi-timeframe indicators', error);
      throw error;
    }
  }

  // ==================== Helper Methods ====================

  private calculateRSI(prices: number[], period: number): number {
    const rsiValues = RSI.calculate({ values: prices, period });
    return rsiValues[rsiValues.length - 1] || 50;
  }

  private calculateEMA(prices: number[], period: number): number {
    const emaValues = EMA.calculate({ values: prices, period });
    return emaValues[emaValues.length - 1] || prices[prices.length - 1];
  }

  private calculateSMA(prices: number[], period: number): number {
    const smaValues = SMA.calculate({ values: prices, period });
    return smaValues[smaValues.length - 1] || prices[prices.length - 1];
  }

  private calculateMACD(prices: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): MACDResult {
    const macdValues = MACD.calculate({
      values: prices,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const last = macdValues[macdValues.length - 1];
    return {
      macd: last?.MACD || 0,
      signal: last?.signal || 0,
      histogram: last?.histogram || 0,
    };
  }

  private calculateBollingerBands(prices: number[], period: number, stdDev: number): BollingerBandsResult {
    const bbValues = BollingerBands.calculate({ values: prices, period, stdDev });
    const last = bbValues[bbValues.length - 1];
    return {
      upper: last?.upper || 0,
      middle: last?.middle || 0,
      lower: last?.lower || 0,
    };
  }

  private calculateATR(high: number[], low: number[], close: number[], period: number): number {
    const atrValues = ATR.calculate({ high, low, close, period });
    return atrValues[atrValues.length - 1] || 0;
  }

  private determineEMATrend(fastEMA: number, slowEMA: number): 'bullish' | 'bearish' | 'neutral' {
    const diff = (fastEMA - slowEMA) / slowEMA;
    if (diff > 0.001) return 'bullish';
    if (diff < -0.001) return 'bearish';
    return 'neutral';
  }
  /**
   * Determines market trend based on EMAs
   * Soglia ridotta per scalping (0.2% invece di 1%)
   */
  getEMATrend(indicators: Indicators): 'bullish' | 'bearish' | 'neutral' {
    // Soglia 0.2% per rilevare trend anche su timeframe brevi
    if (indicators.ema12 > indicators.ema26 * 1.002) {
      return 'bullish';
    } else if (indicators.ema12 < indicators.ema26 * 0.998) {
      return 'bearish';
    }
    return 'neutral';
  }

  /**
   * Checks if RSI indicates oversold condition
   */
  isRSIOversold(rsi: number): boolean {
    return rsi < INDICATOR_CONSTANTS.RSI_OVERSOLD;
  }

  /**
   * Checks if RSI indicates overbought condition
   */
  isRSIOverbought(rsi: number): boolean {
    return rsi > INDICATOR_CONSTANTS.RSI_OVERBOUGHT;
  }

  /**
   * Checks if MACD shows bullish crossover
   */
  isMACDBullishCrossover(macd: MACDResult): boolean {
    return macd.histogram > 0 && macd.macd > macd.signal;
  }

  /**
   * Checks if MACD shows bearish crossover
   */
  isMACDBearishCrossover(macd: MACDResult): boolean {
    return macd.histogram < 0 && macd.macd < macd.signal;
  }

  /**
   * Gets Bollinger Band position
   */
  getBollingerPosition(
    currentPrice: number,
    bands: BollingerBandsResult
  ): 'upper' | 'middle' | 'lower' | 'outside-upper' | 'outside-lower' {
    if (currentPrice > bands.upper) return 'outside-upper';
    if (currentPrice < bands.lower) return 'outside-lower';
    if (currentPrice > bands.middle) return 'upper';
    if (currentPrice < bands.middle) return 'lower';
    return 'middle';
  }

  /**
   * Analyzes volume compared to average
   */
  getVolumeAnalysis(currentVolume: number, averageVolume: number): {
    isHighVolume: boolean;
    volumeRatio: number;
  } {
    const volumeRatio = currentVolume / averageVolume;
    return {
      isHighVolume: volumeRatio > 1.5,
      volumeRatio,
    };
  }

  /**
   * Generates a comprehensive market analysis summary
   */
  analyzeMarket(indicators: Indicators, currentPrice: number, currentVolume: number): {
    trend: string;
    strength: string;
    signals: string[];
  } {
    const signals: string[] = [];
    const trend = this.getEMATrend(indicators);

    // RSI signals
    if (this.isRSIOversold(indicators.rsi)) {
      signals.push('RSI Oversold - Potential Buy');
    } else if (this.isRSIOverbought(indicators.rsi)) {
      signals.push('RSI Overbought - Potential Sell');
    }

    // MACD signals
    if (this.isMACDBullishCrossover(indicators.macd)) {
      signals.push('MACD Bullish Crossover');
    } else if (this.isMACDBearishCrossover(indicators.macd)) {
      signals.push('MACD Bearish Crossover');
    }

    // Bollinger Band signals
    const bbPosition = this.getBollingerPosition(currentPrice, indicators.bollingerBands);
    if (bbPosition === 'outside-lower') {
      signals.push('Price Below Lower BB - Oversold');
    } else if (bbPosition === 'outside-upper') {
      signals.push('Price Above Upper BB - Overbought');
    }

    // Volume analysis
    const volumeAnalysis = this.getVolumeAnalysis(currentVolume, indicators.volumeAverage);
    if (volumeAnalysis.isHighVolume) {
      signals.push(`High Volume (${volumeAnalysis.volumeRatio.toFixed(2)}x avg)`);
    }

    // Trend strength
    const emaDiff = Math.abs(indicators.ema12 - indicators.ema26) / indicators.ema26;
    const strength = emaDiff > 0.03 ? 'strong' : emaDiff > 0.01 ? 'moderate' : 'weak';

    return {
      trend: trend.toUpperCase(),
      strength: strength.toUpperCase(),
      signals,
    };
  }
}

// Export singleton instance
export const indicatorService = new IndicatorService();
export default indicatorService;
