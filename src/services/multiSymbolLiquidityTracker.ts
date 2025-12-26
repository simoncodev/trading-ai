import { logger } from '../core/logger';
import { EventEmitter } from 'events';
import { config } from '../utils/config';
import hyperliquidService from './hyperliquidService';
import { spooferProfiler } from './spooferProfiler';

/**
 * MULTI-SYMBOL LIQUIDITY TRACKER
 * 
 * Gestisce il tracking della liquidità per multipli simboli contemporaneamente.
 * Ogni simbolo ha il proprio stato di spoofing e segnali anti-spoofing.
 */

// ========================================
// TYPES
// ========================================

export interface SpoofingAlert {
  timestamp: number;
  symbol: string;
  priceLevel: number;
  side: 'BID' | 'ASK';
  originalSize: number;
  disappearedSize: number;
  confidence: number;
  message: string;
}

export interface TrackedLiquidityPool {
  id: string;
  symbol: string;
  priceLevel: number;
  side: 'BID' | 'ASK';
  totalSize: number;
  orderCount: number;
  distancePercent: number;
  magnetScore: number;
  firstSeen: number;
  lastSeen: number;
  sizeHistory: { timestamp: number; size: number }[];
  disappearances: number;
  isLikelySpoofing: boolean;
  stabilityScore: number;
}

export interface SymbolSnapshot {
  timestamp: number;
  symbol: string;
  currentPrice: number;
  bidPools: TrackedLiquidityPool[];
  askPools: TrackedLiquidityPool[];
  waveDirection: 'UP' | 'DOWN' | 'NEUTRAL';
  waveStrength: number;
  waveMomentum: number;
  spoofingAlerts: SpoofingAlert[];
  totalBidLiquidity: number;
  totalAskLiquidity: number;
  liquidityDelta: number;
  deltaChange: number;
}

export interface AntiSpoofingSignal {
  action: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  reasoning: string;
  details: {
    askSpoofCount: number;
    bidSpoofCount: number;
    askSpoofVolume: number;
    bidSpoofVolume: number;
    spoofRatio: number;
    highConfidenceAlerts: number;
    currentPrice: number;
  };
}

interface SymbolState {
  symbol: string;
  isRunning: boolean;
  intervalId: NodeJS.Timeout | null;
  trackedPools: Map<string, TrackedLiquidityPool>;
  snapshotHistory: SymbolSnapshot[];
  spoofingAlerts: SpoofingAlert[];
  currentSnapshot: SymbolSnapshot | null;
}

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  SNAPSHOT_INTERVAL_MS: 500,
  POOL_MEMORY_MS: 30000,
  MAX_DISTANCE_PERCENT: 2.0,
  ORDER_BOOK_DEPTH: 100,
  SPOOFING_DISAPPEAR_THRESHOLD: 3,
  SPOOFING_TIME_WINDOW_MS: 5000,
  MIN_SIZE_FOR_SPOOFING: 0.3,
  WAVE_HISTORY_LENGTH: 20,
  MOMENTUM_WINDOW: 5,
  // Filtro falsi positivi - AGGRESSIVO per wave surfing
  MIN_DOMINANCE_FOR_SIGNAL: 0.52,  // 52% dominanza minima (era 60%)
  MIN_CONFIDENCE_FOR_SIGNAL: 50,    // 50% confidence minima (era 60%)
  MIN_SPOOF_ALERTS: 3,              // Almeno 3 alert
  MICRO_STABILITY_MS: 3000,         // Segnale deve persistere 3 secondi
};

// Size minime per crypto (approssimative per spoofing detection)
const MIN_SPOOF_SIZE: Record<string, number> = {
  'BTC-USDC': 0.3,    // 0.3 BTC
  'ETH-USDC': 2.0,    // 2 ETH
  'SOL-USDC': 50,     // 50 SOL
  'DOGE-USDC': 50000, // 50k DOGE
  'XRP-USDC': 5000,   // 5k XRP
};

// ========================================
// MULTI-SYMBOL LIQUIDITY TRACKER CLASS
// ========================================

class MultiSymbolLiquidityTracker extends EventEmitter {
  private symbolStates: Map<string, SymbolState> = new Map();
  private signalHistory: Map<string, { timestamp: number; action: string }[]> = new Map();

  constructor() {
    super();
  }

  /**
   * Start tracking for all configured symbols
   */
  startAll(): void {
    const symbols = config.trading.symbols;
    logger.info(`[MultiSymbolTracker] Starting tracking for ${symbols.length} symbols: ${symbols.join(', ')}`);
    
    for (const symbol of symbols) {
      this.startSymbol(symbol);
    }
  }

  /**
   * Start tracking for a single symbol
   */
  startSymbol(symbol: string): void {
    if (this.symbolStates.has(symbol) && this.symbolStates.get(symbol)!.isRunning) {
      logger.warn(`[MultiSymbolTracker] ${symbol} already running`);
      return;
    }

    const state: SymbolState = {
      symbol,
      isRunning: true,
      intervalId: null,
      trackedPools: new Map(),
      snapshotHistory: [],
      spoofingAlerts: [],
      currentSnapshot: null,
    };

    this.symbolStates.set(symbol, state);
    this.signalHistory.set(symbol, []);

    // Start capturing snapshots
    this.captureSnapshot(symbol);
    state.intervalId = setInterval(() => this.captureSnapshot(symbol), CONFIG.SNAPSHOT_INTERVAL_MS);

    logger.info(`[MultiSymbolTracker] Started tracking ${symbol}`);
  }

  /**
   * Stop tracking for a symbol
   */
  stopSymbol(symbol: string): void {
    const state = this.symbolStates.get(symbol);
    if (state) {
      if (state.intervalId) {
        clearInterval(state.intervalId);
      }
      state.isRunning = false;
      logger.info(`[MultiSymbolTracker] Stopped tracking ${symbol}`);
    }
  }

  /**
   * Stop all tracking
   */
  stopAll(): void {
    for (const symbol of this.symbolStates.keys()) {
      this.stopSymbol(symbol);
    }
  }

  /**
   * Capture snapshot for a symbol
   */
  private async captureSnapshot(symbol: string): Promise<void> {
    const state = this.symbolStates.get(symbol);
    if (!state || !state.isRunning) return;

    try {
      const orderBook = await hyperliquidService.getOrderBook(symbol, CONFIG.ORDER_BOOK_DEPTH);
      
      if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
        return;
      }

      const bestBid = orderBook.bids[0].price;
      const bestAsk = orderBook.asks[0].price;
      const currentPrice = (bestBid + bestAsk) / 2;
      const timestamp = Date.now();

      // Identifica pools
      const currentBidPools = this.identifyPools(symbol, orderBook.bids, currentPrice, 'BID', timestamp);
      const currentAskPools = this.identifyPools(symbol, orderBook.asks, currentPrice, 'ASK', timestamp);

      // Rileva spoofing
      const newAlerts = this.detectSpoofing(symbol, currentBidPools, currentAskPools, timestamp);
      state.spoofingAlerts.push(...newAlerts);

      // Mantieni solo alert recenti (ultimo minuto)
      const recentThreshold = timestamp - 60000;
      state.spoofingAlerts = state.spoofingAlerts.filter(a => a.timestamp > recentThreshold);

      // Calcola wave analysis
      const { waveDirection, waveStrength, waveMomentum } = this.analyzeWave(state);

      // Calcola statistiche
      const totalBidLiquidity = orderBook.bids.reduce((sum, l) => sum + l.size, 0);
      const totalAskLiquidity = orderBook.asks.reduce((sum, l) => sum + l.size, 0);
      const liquidityDelta = totalBidLiquidity - totalAskLiquidity;
      const previousDelta = state.currentSnapshot?.liquidityDelta || liquidityDelta;
      const deltaChange = liquidityDelta - previousDelta;

      // Crea snapshot
      const snapshot: SymbolSnapshot = {
        timestamp,
        symbol,
        currentPrice,
        bidPools: currentBidPools,
        askPools: currentAskPools,
        waveDirection,
        waveStrength,
        waveMomentum,
        spoofingAlerts: newAlerts,
        totalBidLiquidity,
        totalAskLiquidity,
        liquidityDelta,
        deltaChange,
      };

      state.currentSnapshot = snapshot;
      state.snapshotHistory.push(snapshot);

      // Mantieni solo ultimi N snapshot
      if (state.snapshotHistory.length > CONFIG.WAVE_HISTORY_LENGTH) {
        state.snapshotHistory.shift();
      }

      // Emetti evento
      this.emit('snapshot', { symbol, snapshot });

      // Feed alerts to profiler
      if (newAlerts.length > 0) {
        spooferProfiler.processAlerts(newAlerts);
        
        for (const alert of newAlerts) {
          logger.warn(`🚨 [${symbol}] SPOOFING: ${alert.message}`);
        }
      }

    } catch (error) {
      logger.debug(`[MultiSymbolTracker] Error capturing ${symbol} snapshot: ${error}`);
    }
  }

  /**
   * Identify liquidity pools
   */
  private identifyPools(
    symbol: string,
    levels: { price: number; size: number }[],
    currentPrice: number,
    side: 'BID' | 'ASK',
    timestamp: number
  ): TrackedLiquidityPool[] {
    if (levels.length === 0) return [];

    const state = this.symbolStates.get(symbol);
    if (!state) return [];

    const relevantLevels = levels.filter(l => {
      const dist = Math.abs(l.price - currentPrice) / currentPrice * 100;
      return dist <= CONFIG.MAX_DISTANCE_PERCENT;
    });

    if (relevantLevels.length === 0) return [];

    const sizes = relevantLevels.map(l => l.size);
    const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const maxSize = Math.max(...sizes);

    const pools: TrackedLiquidityPool[] = [];

    for (const level of relevantLevels) {
      if (level.size >= avgSize * 0.5) {
        const distancePercent = Math.abs(level.price - currentPrice) / currentPrice * 100;
        const sizeScore = Math.min(level.size / maxSize, 1) * 50;
        const distanceScore = Math.max(0, 1 - distancePercent / CONFIG.MAX_DISTANCE_PERCENT) * 30;
        const magnetScore = Math.round(sizeScore + distanceScore + 20);

        const id = `${symbol}-${side}-${level.price.toFixed(2)}`;
        const existing = state.trackedPools.get(id);

        const pool: TrackedLiquidityPool = {
          id,
          symbol,
          priceLevel: level.price,
          side,
          totalSize: level.size,
          orderCount: 1,
          distancePercent,
          magnetScore,
          firstSeen: existing?.firstSeen || timestamp,
          lastSeen: timestamp,
          sizeHistory: existing?.sizeHistory || [],
          disappearances: existing?.disappearances || 0,
          isLikelySpoofing: existing?.isLikelySpoofing || false,
          stabilityScore: existing?.stabilityScore || 100,
        };

        // Update size history
        pool.sizeHistory.push({ timestamp, size: level.size });
        if (pool.sizeHistory.length > 20) {
          pool.sizeHistory.shift();
        }

        pools.push(pool);
        state.trackedPools.set(id, pool);
      }
    }

    // Check for disappeared pools (spoofing detection)
    const currentPoolIds = new Set(pools.map(p => p.id));
    for (const [poolId, existingPool] of state.trackedPools.entries()) {
      if (existingPool.side === side && !currentPoolIds.has(poolId)) {
        const timeSinceLastSeen = timestamp - existingPool.lastSeen;
        if (timeSinceLastSeen < CONFIG.POOL_MEMORY_MS) {
          // Pool disappeared recently - potential spoofing
          existingPool.disappearances++;
          existingPool.stabilityScore = Math.max(0, existingPool.stabilityScore - 20);
          
          if (existingPool.disappearances >= CONFIG.SPOOFING_DISAPPEAR_THRESHOLD) {
            existingPool.isLikelySpoofing = true;
          }
        }
      }
    }

    // Cleanup old pools
    const cleanupThreshold = timestamp - CONFIG.POOL_MEMORY_MS;
    for (const [poolId, pool] of state.trackedPools.entries()) {
      if (pool.lastSeen < cleanupThreshold) {
        state.trackedPools.delete(poolId);
      }
    }

    return pools;
  }

  /**
   * Detect spoofing patterns
   */
  private detectSpoofing(
    symbol: string,
    _bidPools: TrackedLiquidityPool[],
    _askPools: TrackedLiquidityPool[],
    timestamp: number
  ): SpoofingAlert[] {
    const alerts: SpoofingAlert[] = [];
    const state = this.symbolStates.get(symbol);
    if (!state) return alerts;

    const minSize = MIN_SPOOF_SIZE[symbol] || 1;

    // Check all tracked pools for spoofing behavior
    for (const pool of state.trackedPools.values()) {
      if (pool.isLikelySpoofing && pool.totalSize >= minSize && pool.lastSeen === timestamp) {
        alerts.push({
          timestamp,
          symbol,
          priceLevel: pool.priceLevel,
          side: pool.side,
          originalSize: pool.totalSize,
          disappearedSize: pool.totalSize,
          confidence: Math.min(95, 60 + pool.disappearances * 10),
          message: `Ordine fantasma rilevato @ $${pool.priceLevel.toFixed(2)} (${pool.side}) - sparito ${pool.disappearances}x`,
        });
      }
    }

    return alerts;
  }

  /**
   * Analyze wave direction
   */
  private analyzeWave(state: SymbolState): { waveDirection: 'UP' | 'DOWN' | 'NEUTRAL'; waveStrength: number; waveMomentum: number } {
    if (state.snapshotHistory.length < 3) {
      return { waveDirection: 'NEUTRAL', waveStrength: 0, waveMomentum: 0 };
    }

    const recent = state.snapshotHistory.slice(-CONFIG.MOMENTUM_WINDOW);
    const deltaChanges = recent.map(s => s.liquidityDelta);
    const avgDelta = deltaChanges.reduce((a, b) => a + b, 0) / deltaChanges.length;

    const current = state.currentSnapshot;
    const waveMomentum = current ? current.deltaChange : 0;

    let waveDirection: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    let waveStrength = 0;

    if (avgDelta > 0) {
      waveDirection = 'UP';
      waveStrength = Math.min(100, Math.abs(avgDelta) * 10);
    } else if (avgDelta < 0) {
      waveDirection = 'DOWN';
      waveStrength = Math.min(100, Math.abs(avgDelta) * 10);
    }

    return { waveDirection, waveStrength, waveMomentum };
  }

  /**
   * Get anti-spoofing signal for a symbol
   * Implementa filtro falsi positivi
   */
  getAntiSpoofingSignal(symbol: string): AntiSpoofingSignal {
    const state = this.symbolStates.get(symbol);
    
    if (!state || !state.currentSnapshot) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: `No data for ${symbol}`,
        details: {
          askSpoofCount: 0, bidSpoofCount: 0,
          askSpoofVolume: 0, bidSpoofVolume: 0,
          spoofRatio: 0, highConfidenceAlerts: 0,
          currentPrice: 0,
        },
      };
    }

    // Alert recenti ad alta confidenza
    const recentAlerts = state.spoofingAlerts.filter(a => 
      Date.now() - a.timestamp < 30000 && a.confidence >= 80
    );

    if (recentAlerts.length < CONFIG.MIN_SPOOF_ALERTS) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: `Spoofing insufficiente per ${symbol} (${recentAlerts.length}/${CONFIG.MIN_SPOOF_ALERTS} alerts)`,
        details: {
          askSpoofCount: 0, bidSpoofCount: 0,
          askSpoofVolume: 0, bidSpoofVolume: 0,
          spoofRatio: 0, highConfidenceAlerts: recentAlerts.length,
          currentPrice: state.currentSnapshot.currentPrice,
        },
      };
    }

    // Separa per side
    const askSpoof = recentAlerts.filter(a => a.side === 'ASK');
    const bidSpoof = recentAlerts.filter(a => a.side === 'BID');

    const askVolume = askSpoof.reduce((sum, a) => sum + a.originalSize, 0);
    const bidVolume = bidSpoof.reduce((sum, a) => sum + a.originalSize, 0);
    const totalVolume = askVolume + bidVolume;

    const minVolume = MIN_SPOOF_SIZE[symbol] || 1;
    if (totalVolume < minVolume) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: `Volume spoofing troppo basso per ${symbol}`,
        details: {
          askSpoofCount: askSpoof.length,
          bidSpoofCount: bidSpoof.length,
          askSpoofVolume: askVolume,
          bidSpoofVolume: bidVolume,
          spoofRatio: 0,
          highConfidenceAlerts: recentAlerts.length,
          currentPrice: state.currentSnapshot.currentPrice,
        },
      };
    }

    // Calcola ratio
    const askRatio = askVolume / totalVolume;
    const bidRatio = bidVolume / totalVolume;
    const dominantRatio = Math.max(askRatio, bidRatio);

    let action: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
    let reasoning = '';

    // FILTRO FALSI POSITIVI: verifica dominanza chiara
    if (askRatio >= CONFIG.MIN_DOMINANCE_FOR_SIGNAL) {
      action = 'BUY';
      reasoning = `🎯 [${symbol}] ASK SPOOFING (${(askRatio*100).toFixed(0)}%) - Whale accumulating! ` +
                  `Fake sell walls: ${askSpoof.length} alerts, ${askVolume.toFixed(4)} units.`;
    } else if (bidRatio >= CONFIG.MIN_DOMINANCE_FOR_SIGNAL) {
      action = 'SELL';
      reasoning = `🎯 [${symbol}] BID SPOOFING (${(bidRatio*100).toFixed(0)}%) - Whale distributing! ` +
                  `Fake buy walls: ${bidSpoof.length} alerts, ${bidVolume.toFixed(4)} units.`;
    } else {
      reasoning = `[${symbol}] Mixed spoofing (ASK: ${(askRatio*100).toFixed(0)}%, BID: ${(bidRatio*100).toFixed(0)}%) - FALSO POSITIVO`;
    }

    // Calcola confidence
    const volumeScore = Math.min(40, totalVolume / minVolume * 10);
    const dominanceScore = (dominantRatio - 0.5) * 80;
    const countScore = Math.min(20, recentAlerts.length * 2);
    const confidence = action !== 'WAIT' ? Math.min(95, volumeScore + dominanceScore + countScore) : 0;

    // Registra segnale per tracking
    this.recordSignal(symbol, action);

    return {
      action,
      confidence: Math.round(confidence),
      reasoning,
      details: {
        askSpoofCount: askSpoof.length,
        bidSpoofCount: bidSpoof.length,
        askSpoofVolume: parseFloat(askVolume.toFixed(4)),
        bidSpoofVolume: parseFloat(bidVolume.toFixed(4)),
        spoofRatio: parseFloat(dominantRatio.toFixed(4)),
        highConfidenceAlerts: recentAlerts.length,
        currentPrice: state.currentSnapshot.currentPrice,
      },
    };
  }

  /**
   * Record signal for stability tracking
   */
  private recordSignal(symbol: string, action: string): void {
    const history = this.signalHistory.get(symbol) || [];
    history.push({ timestamp: Date.now(), action });
    
    // Keep only last 10 seconds
    const cutoff = Date.now() - 10000;
    this.signalHistory.set(symbol, history.filter(h => h.timestamp > cutoff));
  }

  /**
   * NEW: Get wall pressure signal based on active BID/ASK ratio
   * Instead of waiting for spoofing to disappear, we trade WITH the wall pressure
   * 
   * Logic:
   * - BID >> ASK (ratio > threshold) → Whales pushing price UP → BUY
   * - ASK >> BID (ratio > threshold) → Whales pushing price DOWN → SELL
   * - Ratio balanced → WAIT
   */
  getWallPressureSignal(symbol: string): AntiSpoofingSignal {
    const state = this.symbolStates.get(symbol);
    
    if (!state || !state.currentSnapshot) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: `No data for ${symbol}`,
        details: {
          askSpoofCount: 0, bidSpoofCount: 0,
          askSpoofVolume: 0, bidSpoofVolume: 0,
          spoofRatio: 0, highConfidenceAlerts: 0,
          currentPrice: 0,
        },
      };
    }

    const snapshot = state.currentSnapshot;
    const bidLiquidity = snapshot.totalBidLiquidity;
    const askLiquidity = snapshot.totalAskLiquidity;
    const totalLiquidity = bidLiquidity + askLiquidity;
    const currentPrice = snapshot.currentPrice;

    // Minimum liquidity threshold
    const minLiquidity = MIN_SPOOF_SIZE[symbol] || 1;
    if (totalLiquidity < minLiquidity * 2) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: `[${symbol}] Insufficient liquidity: ${totalLiquidity.toFixed(4)}`,
        details: {
          askSpoofCount: snapshot.askPools.length,
          bidSpoofCount: snapshot.bidPools.length,
          askSpoofVolume: askLiquidity,
          bidSpoofVolume: bidLiquidity,
          spoofRatio: 0,
          highConfidenceAlerts: 0,
          currentPrice,
        },
      };
    }

    // Calculate ratio
    const bidRatio = bidLiquidity / totalLiquidity;
    const askRatio = askLiquidity / totalLiquidity;
    
    // Wall pressure ratio (how much bigger one side is vs the other)
    const pressureRatio = bidLiquidity > askLiquidity 
      ? bidLiquidity / askLiquidity 
      : askLiquidity / bidLiquidity;

    // Thresholds for signal generation
    const MIN_PRESSURE_RATIO = 2.0;      // One side must be 2x the other
    const STRONG_PRESSURE_RATIO = 3.0;   // 3x = strong signal
    const EXTREME_PRESSURE_RATIO = 4.0;  // 4x = very strong signal

    let action: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
    let reasoning = '';
    let confidence = 0;

    if (pressureRatio >= MIN_PRESSURE_RATIO) {
      if (bidRatio > askRatio) {
        // BID dominates → Whales are pushing price UP → BUY
        action = 'BUY';
        reasoning = `🐋 [${symbol}] WALL PRESSURE BUY - BID wall ${pressureRatio.toFixed(1)}x stronger! ` +
                    `BID: ${bidLiquidity.toFixed(2)} vs ASK: ${askLiquidity.toFixed(2)} → Price pushed UP`;
      } else {
        // ASK dominates → Whales are pushing price DOWN → SELL
        action = 'SELL';
        reasoning = `🐋 [${symbol}] WALL PRESSURE SELL - ASK wall ${pressureRatio.toFixed(1)}x stronger! ` +
                    `ASK: ${askLiquidity.toFixed(2)} vs BID: ${bidLiquidity.toFixed(2)} → Price pushed DOWN`;
      }

      // Calculate confidence based on pressure ratio
      if (pressureRatio >= EXTREME_PRESSURE_RATIO) {
        confidence = 90 + Math.min(5, (pressureRatio - EXTREME_PRESSURE_RATIO) * 2);
      } else if (pressureRatio >= STRONG_PRESSURE_RATIO) {
        confidence = 80 + (pressureRatio - STRONG_PRESSURE_RATIO) * 10;
      } else {
        confidence = 65 + (pressureRatio - MIN_PRESSURE_RATIO) * 15;
      }
      confidence = Math.min(95, Math.round(confidence));
    } else {
      reasoning = `[${symbol}] Wall balanced (ratio: ${pressureRatio.toFixed(2)}x) - No clear pressure`;
    }

    // Record signal for stability tracking
    this.recordSignal(symbol, action);

    return {
      action,
      confidence,
      reasoning,
      details: {
        askSpoofCount: snapshot.askPools.length,
        bidSpoofCount: snapshot.bidPools.length,
        askSpoofVolume: parseFloat(askLiquidity.toFixed(4)),
        bidSpoofVolume: parseFloat(bidLiquidity.toFixed(4)),
        spoofRatio: parseFloat(pressureRatio.toFixed(4)),
        highConfidenceAlerts: state.spoofingAlerts.filter(a => 
          Date.now() - a.timestamp < 30000 && a.confidence >= 80
        ).length,
        currentPrice,
      },
    };
  }

  /**
   * Get snapshot for a symbol
   */
  getSnapshot(symbol: string): SymbolSnapshot | null {
    return this.symbolStates.get(symbol)?.currentSnapshot || null;
  }

  /**
   * Get all snapshots
   */
  getAllSnapshots(): Record<string, SymbolSnapshot | null> {
    const result: Record<string, SymbolSnapshot | null> = {};
    for (const [symbol, state] of this.symbolStates.entries()) {
      result[symbol] = state.currentSnapshot;
    }
    return result;
  }

  /**
   * Get all anti-spoofing signals
   */
  getAllSignals(): Record<string, AntiSpoofingSignal> {
    const result: Record<string, AntiSpoofingSignal> = {};
    for (const symbol of this.symbolStates.keys()) {
      result[symbol] = this.getAntiSpoofingSignal(symbol);
    }
    return result;
  }

  /**
   * Get spoofing alerts for a symbol
   */
  getSpoofingAlerts(symbol: string): SpoofingAlert[] {
    return this.symbolStates.get(symbol)?.spoofingAlerts || [];
  }

  /**
   * Get all spoofing alerts
   */
  getAllSpoofingAlerts(): Record<string, SpoofingAlert[]> {
    const result: Record<string, SpoofingAlert[]> = {};
    for (const [symbol, state] of this.symbolStates.entries()) {
      result[symbol] = state.spoofingAlerts;
    }
    return result;
  }

  /**
   * Get tracking status
   */
  getStatus(): { symbols: string[]; running: string[]; stopped: string[] } {
    const symbols = Array.from(this.symbolStates.keys());
    const running = symbols.filter(s => this.symbolStates.get(s)?.isRunning);
    const stopped = symbols.filter(s => !this.symbolStates.get(s)?.isRunning);
    return { symbols, running, stopped };
  }
}

export const multiSymbolTracker = new MultiSymbolLiquidityTracker();
export default multiSymbolTracker;
