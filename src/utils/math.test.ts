import { calculateSMA, calculateEMA, calculateStdDev, percentageChange, roundTo } from '../utils/math';

describe('Math Utilities', () => {
  describe('roundTo', () => {
    it('should round to specified decimal places', () => {
      expect(roundTo(3.14159, 2)).toBe(3.14);
      expect(roundTo(3.14159, 4)).toBe(3.1416);
      expect(roundTo(100.999, 0)).toBe(101);
    });
  });

  describe('percentageChange', () => {
    it('should calculate percentage change correctly', () => {
      expect(percentageChange(100, 110)).toBe(10);
      expect(percentageChange(100, 90)).toBe(-10);
      expect(percentageChange(0, 50)).toBe(0);
    });
  });

  describe('calculateSMA', () => {
    it('should calculate simple moving average', () => {
      const values = [1, 2, 3, 4, 5];
      expect(calculateSMA(values, 3)).toBe(4); // Average of [3, 4, 5]
      expect(calculateSMA(values, 5)).toBe(3); // Average of all
    });

    it('should throw error for insufficient data', () => {
      const values = [1, 2];
      expect(() => calculateSMA(values, 3)).toThrow();
    });
  });

  describe('calculateEMA', () => {
    it('should calculate exponential moving average', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const ema = calculateEMA(values, 5);
      expect(ema).toBeGreaterThan(5);
      expect(ema).toBeLessThan(10);
    });
  });

  describe('calculateStdDev', () => {
    it('should calculate standard deviation', () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const stdDev = calculateStdDev(values);
      expect(stdDev).toBeCloseTo(2, 1);
    });
  });
});
