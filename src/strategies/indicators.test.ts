import { indicatorService } from '../strategies/indicators';
import { Candle, Indicators } from '../types';

describe('IndicatorService', () => {
  const mockCandles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: Date.now() - (100 - i) * 60000,
    open: 100 + Math.random() * 10,
    high: 105 + Math.random() * 10,
    low: 95 + Math.random() * 10,
    close: 100 + Math.random() * 10,
    volume: 1000 + Math.random() * 500,
  }));

  describe('getIndicators', () => {
    it('should calculate all indicators', async () => {
      const indicators = await indicatorService.getIndicators(mockCandles);

      expect(indicators).toHaveProperty('rsi');
      expect(indicators).toHaveProperty('macd');
      expect(indicators).toHaveProperty('ema12');
      expect(indicators).toHaveProperty('ema26');
      expect(indicators).toHaveProperty('bollingerBands');

      expect(indicators.rsi).toBeGreaterThanOrEqual(0);
      expect(indicators.rsi).toBeLessThanOrEqual(100);
    });

    it('should throw error for insufficient data', async () => {
      const insufficientCandles = mockCandles.slice(0, 10);
      await expect(indicatorService.getIndicators(insufficientCandles)).rejects.toThrow();
    });
  });

  describe('getEMATrend', () => {
    it('should identify bullish trend', () => {
      const indicators: Indicators = {
        rsi: 50,
        macd: { macd: 0, signal: 0, histogram: 0 },
        ema12: 110,
        ema26: 100,
        bollingerBands: { upper: 120, middle: 100, lower: 80 },
        sma20: 100,
        atr: 2,
        volumeAverage: 1000,
      };

      expect(indicatorService.getEMATrend(indicators)).toBe('bullish');
    });

    it('should identify bearish trend', () => {
      const indicators: Indicators = {
        rsi: 50,
        macd: { macd: 0, signal: 0, histogram: 0 },
        ema12: 90,
        ema26: 100,
        bollingerBands: { upper: 120, middle: 100, lower: 80 },
        sma20: 100,
        atr: 2,
        volumeAverage: 1000,
      };

      expect(indicatorService.getEMATrend(indicators)).toBe('bearish');
    });
  });
});
