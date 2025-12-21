/**
 * Hyperliquid Fee Structure (Perpetual Futures)
 * 
 * Source: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 * 
 * Fee Tiers based on 14-day rolling volume:
 * - Tier 0 (< $1M): Maker 0.010% (rebate), Taker 0.035%
 * - Tier 1 ($1M-$5M): Maker 0.008% (rebate), Taker 0.032%
 * - Tier 2 ($5M-$25M): Maker 0.005% (rebate), Taker 0.030%
 * - Tier 3 ($25M-$100M): Maker 0.002% (rebate), Taker 0.027%
 * - Tier 4 ($100M-$500M): Maker -0.001% (rebate), Taker 0.025%
 * - VIP: Even lower
 * 
 * For market orders (which we use), we pay TAKER fees.
 * For limit orders, we get MAKER rebate.
 */

export interface FeeStructure {
  makerRate: number;  // Usually negative (rebate)
  takerRate: number;  // Always positive (cost)
}

// Default to Tier 0 (new users)
export const HYPERLIQUID_FEES = {
  TIER_0: {
    makerRate: -0.00010, // -0.010% rebate
    takerRate: 0.00035,  // 0.035%
  },
  TIER_1: {
    makerRate: -0.00008, // -0.008% rebate
    takerRate: 0.00032,  // 0.032%
  },
  TIER_2: {
    makerRate: -0.00005, // -0.005% rebate
    takerRate: 0.00030,  // 0.030%
  },
  TIER_3: {
    makerRate: -0.00002, // -0.002% rebate
    takerRate: 0.00027,  // 0.027%
  },
  TIER_4: {
    makerRate: 0.00001,  // 0.001% rebate
    takerRate: 0.00025,  // 0.025%
  },
} as const;

// Current active tier (can be configured via env)
const CURRENT_TIER = process.env.HYPERLIQUID_FEE_TIER || 'TIER_0';

/**
 * Get current fee structure based on configured tier
 */
export function getCurrentFees(): FeeStructure {
  return HYPERLIQUID_FEES[CURRENT_TIER as keyof typeof HYPERLIQUID_FEES] || HYPERLIQUID_FEES.TIER_0;
}

/**
 * Calculate entry fee for a trade (TAKER fee - market order)
 * @param notionalValue The notional value of the trade (price * quantity)
 * @returns Fee amount in USD
 */
export function calculateEntryFee(notionalValue: number): number {
  const fees = getCurrentFees();
  return notionalValue * fees.takerRate;
}

/**
 * Calculate exit fee for a trade (TAKER fee - market order)
 * @param notionalValue The notional value of the trade (price * quantity)
 * @returns Fee amount in USD
 */
export function calculateExitFee(notionalValue: number): number {
  const fees = getCurrentFees();
  return notionalValue * fees.takerRate;
}

/**
 * Calculate total round-trip fees (entry + exit)
 * @param entryNotional Entry notional value
 * @param exitNotional Exit notional value
 * @returns Total fees in USD
 */
export function calculateRoundTripFees(entryNotional: number, exitNotional: number): number {
  return calculateEntryFee(entryNotional) + calculateExitFee(exitNotional);
}

/**
 * Calculate net P&L after fees
 * @param grossPnl Gross P&L before fees
 * @param entryPrice Entry price
 * @param exitPrice Exit price
 * @param quantity Position quantity
 * @returns Net P&L after fees
 */
export function calculateNetPnL(
  grossPnl: number,
  entryPrice: number,
  exitPrice: number,
  quantity: number
): number {
  const entryNotional = entryPrice * quantity;
  const exitNotional = exitPrice * quantity;
  const totalFees = calculateRoundTripFees(entryNotional, exitNotional);
  return grossPnl - totalFees;
}

/**
 * Get minimum profit target to breakeven after fees
 * For round-trip trade, need at least 2 * takerRate profit
 */
export function getBreakevenPercentage(): number {
  const fees = getCurrentFees();
  return fees.takerRate * 2 * 100; // Convert to percentage
}

/**
 * Estimate if a trade is profitable after fees
 * @param entryPrice Entry price
 * @param targetPrice Target/exit price
 * @param side Trade side
 * @returns Whether trade would be profitable after fees
 */
export function isTradeProfilableAfterFees(
  entryPrice: number,
  targetPrice: number,
  side: 'buy' | 'sell'
): boolean {
  const priceDiff = side === 'buy' 
    ? (targetPrice - entryPrice) / entryPrice 
    : (entryPrice - targetPrice) / entryPrice;
  
  const breakeven = getBreakevenPercentage() / 100;
  return priceDiff > breakeven;
}

// Export default taker rate for backward compatibility
export const DEFAULT_TAKER_FEE_RATE = HYPERLIQUID_FEES.TIER_0.takerRate; // 0.00035 (0.035%)
