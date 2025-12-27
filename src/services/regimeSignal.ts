import { hyperliquidService } from './hyperliquidService';
import config from '../utils/config';
import { Candle } from '../types';

// ========================================
// CACHE for rate-limiting API calls
// ========================================
const signalCache: Map<string, { signal: RegimeSignal; ts: number }> = new Map();
// TTL configurable via env REGIME_SIGNAL_CACHE_TTL_MS
const getSignalCacheTtlMs = () => config.regime?.regimeSignalCacheTtlMs ?? 5000;

function std(arr: number[]): number {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

export interface RegimeSignal {
  symbol: string;
  ts: number;
  direction: 'LONG' | 'SHORT' | 'NONE';
  compression: boolean;
  volumeSpike: boolean;
  breakout: { up: boolean; down: boolean; level: number };
  metrics: {
    vol5m: number;
    vol30m: number;
    volume1m: number;
    avgVol15m: number;
    rangeHigh: number;
    rangeLow: number;
    price: number;
    funding?: number | null;
  };
}

export async function getRegimeSignal(symbol: string): Promise<RegimeSignal> {
  // Check cache first
  const cached = signalCache.get(symbol);
  const ttl = getSignalCacheTtlMs();
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.signal;
  }

  // Fetch recent 1m candles for max needed window (at least 30 + 15)
  const limit = Math.max(config.regime!.volLongMinutes, config.regime!.rangeWindowMinutes, 30) + 5;
  const candles: Candle[] = await hyperliquidService.getCandles(symbol, '1m', limit);
  if (!candles || candles.length === 0) {
    throw new Error('No candles available for signal');
  }

  // Ensure chronological ascending
  const sorted = candles.sort((a, b) => a.timestamp - b.timestamp);

  // Price series
  const closes = sorted.map(c => c.close);
  const volumes = sorted.map(c => c.volume);

  // Compute log returns
  const logReturns = [] as number[];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const volShortN = Math.min(config.regime!.volShortMinutes, logReturns.length);
  const volLongN = Math.min(config.regime!.volLongMinutes, logReturns.length);

  const vol5m = std(logReturns.slice(-volShortN)) * Math.sqrt(60); // scale to per-minute->per-hour-ish, keep relative
  const vol30m = std(logReturns.slice(-volLongN)) * Math.sqrt(60);

  const volume1m = volumes[volumes.length - 1] || 0;
  const avgVol15m = (() => {
    const n = Math.min(config.regime!.rangeWindowMinutes, volumes.length);
    const slice = volumes.slice(-n);
    if (slice.length === 0) return 0;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  })();

  const rangeWindow = Math.min(config.regime!.rangeWindowMinutes, sorted.length);
  const recent = sorted.slice(-rangeWindow);
  const rangeHigh = Math.max(...recent.map(c => c.high));
  const rangeLow = Math.min(...recent.map(c => c.low));

  const lastPrice = closes[closes.length - 1];

  const breakoutUp = lastPrice > rangeHigh;
  const breakoutDown = lastPrice < rangeLow;

  const compression = volShortN > 0 && volLongN > 0 ? (vol5m < config.regime!.compressionRatio * vol30m) : false;
  const volumeSpike = avgVol15m > 0 ? volume1m > config.regime!.volumeSpikeMult * avgVol15m : false;

  // Funding data optional - try to read if hyperliquidService has it
  let funding: number | null = null;
  try {
    if ((hyperliquidService as any).getFundingRate) {
      funding = await (hyperliquidService as any).getFundingRate(symbol);
    }
  } catch (e) {
    funding = null;
  }

  let direction: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  if (breakoutUp) direction = 'LONG';
  if (breakoutDown) direction = 'SHORT';

  // Soft funding bias (do not invert signal)
  if (funding !== null && typeof funding === 'number') {
    const f = funding;
    if (f > (config.regime?.fundingFilter ?? 0)) {
      // bias to SHORT (de-prioritize LONG)
      if (direction === 'LONG') direction = 'NONE';
    }
    if (f < -(config.regime?.fundingFilter ?? 0)) {
      if (direction === 'SHORT') direction = 'NONE';
    }
  }

  const result: RegimeSignal = {
    symbol,
    ts: Date.now(),
    direction,
    compression,
    volumeSpike,
    breakout: { up: breakoutUp, down: breakoutDown, level: direction === 'LONG' ? rangeHigh : rangeLow },
    metrics: {
      vol5m,
      vol30m,
      volume1m,
      avgVol15m,
      rangeHigh,
      rangeLow,
      price: lastPrice,
      funding: funding === null ? undefined : funding,
    },
  };

  // Cache the result
  signalCache.set(symbol, { signal: result, ts: Date.now() });

  return result;
}
