/**
 * Mathematical utility functions for trading calculations
 */

/**
 * Rounds a number to a specified number of decimal places
 */
export function roundTo(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}

/**
 * Calculates percentage change between two values
 */
export function percentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Calculates simple moving average
 */
export function calculateSMA(values: number[], period: number): number {
  if (values.length < period) {
    throw new Error(`Insufficient data for SMA calculation. Need ${period}, got ${values.length}`);
  }
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / period;
}

/**
 * Calculates exponential moving average
 */
export function calculateEMA(values: number[], period: number): number {
  if (values.length < period) {
    throw new Error(`Insufficient data for EMA calculation. Need ${period}, got ${values.length}`);
  }

  const multiplier = 2 / (period + 1);
  let ema = calculateSMA(values.slice(0, period), period);

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Calculates standard deviation
 */
export function calculateStdDev(values: number[]): number {
  const mean = values.reduce((acc, val) => acc + val, 0) / values.length;
  const squaredDiffs = values.map((val) => Math.pow(val - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((acc, val) => acc + val, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Clamps a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculates profit/loss percentage
 */
export function calculatePnLPercentage(entryPrice: number, exitPrice: number, side: 'buy' | 'sell'): number {
  if (side === 'buy') {
    return ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }
}

/**
 * Calculates position size based on risk percentage
 */
export function calculatePositionSize(
  accountBalance: number,
  riskPercentage: number,
  entryPrice: number,
  stopLossPrice: number
): number {
  const riskAmount = accountBalance * (riskPercentage / 100);
  const priceRisk = Math.abs(entryPrice - stopLossPrice);
  return riskAmount / priceRisk;
}

/**
 * Normalizes a value to a 0-1 range
 */
export function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

/**
 * Calculates Sharpe ratio
 */
export function calculateSharpeRatio(returns: number[], riskFreeRate = 0): number {
  if (returns.length === 0) return 0;

  const avgReturn = returns.reduce((acc, val) => acc + val, 0) / returns.length;
  const stdDev = calculateStdDev(returns);

  if (stdDev === 0) return 0;

  return (avgReturn - riskFreeRate) / stdDev;
}

/**
 * Calculates maximum drawdown from equity curve
 */
export function calculateMaxDrawdown(equityCurve: number[]): number {
  let maxDrawdown = 0;
  let peak = equityCurve[0];

  for (const equity of equityCurve) {
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = ((peak - equity) / peak) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

/**
 * Formats a number as currency
 */
export function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value);
}

/**
 * Formats a percentage value
 */
export function formatPercentage(value: number, decimals = 2): string {
  return `${roundTo(value, decimals)}%`;
}

/**
 * Checks if a number is within a percentage range of a target
 */
export function isWithinPercentage(value: number, target: number, percentage: number): boolean {
  const margin = target * (percentage / 100);
  return value >= target - margin && value <= target + margin;
}
