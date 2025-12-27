import { logger } from '../core/logger';
import { EventEmitter } from 'events';
import { config } from '../utils/config';
import hyperliquidService from './hyperliquidService';
import { hyperliquidWsClient, BboData } from './hyperliquidWsClient';

/**
 * MULTI-SYMBOL LIQUIDITY TRACKER
 * 
 * Gestisce il tracking della liquidità per multipli simboli contemporaneamente.
 * Usa WebSocket per BBO real-time con HTTP fallback rate-limited.
 */

// ========================================
// TYPES
// ========================================

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
  totalBidLiquidity: number;
  totalAskLiquidity: number;
  liquidityDelta: number;
  deltaChange: number;
}

interface SymbolState {
  symbol: string;
  isRunning: boolean;
  intervalId: NodeJS.Timeout | null;
  trackedPools: Map<string, TrackedLiquidityPool>;
  snapshotHistory: SymbolSnapshot[];
  currentSnapshot: SymbolSnapshot | null;
}

// ========================================
// CONFIGURATION
// ========================================

// ========================================
// CONFIGURATION (from env via config.ts)
// ========================================

const CONFIG = {
  FALLBACK_CHECK_INTERVAL_MS: config.marketData?.fallbackCheckIntervalMs || 30000,
  POOL_MEMORY_MS: 30000,
  MAX_DISTANCE_PERCENT: 2.0,
  ORDER_BOOK_DEPTH: config.marketData?.orderBookDepth || 100,
  WAVE_HISTORY_LENGTH: 10,
  MOMENTUM_WINDOW: 5,
  DATA_STALE_MS: config.regime?.dataStaleMs || 5000,
  USE_WS_MARKET_DATA: config.marketData?.useWsMarketData !== false,
};

// ========================================
// MULTI-SYMBOL LIQUIDITY TRACKER CLASS
// ========================================

class MultiSymbolLiquidityTracker extends EventEmitter {
  private symbolStates: Map<string, SymbolState> = new Map();
  private fallbackIntervalId: NodeJS.Timeout | null = null;
  private wsListenerBound: boolean = false;

  constructor() {
    super();
  }

  /**
   * Start tracking for all configured symbols
   */
  startAll(): void {
    const symbols = config.trading.symbols;
    logger.info(`[MultiSymbolTracker] Starting tracking for ${symbols.length} symbols: ${symbols.join(', ')}`);
    
    // Connect WS if enabled
    if (CONFIG.USE_WS_MARKET_DATA) {
      hyperliquidWsClient.connect();
      
      // Bind WS listener once
      if (!this.wsListenerBound) {
        hyperliquidWsClient.on('bbo', (sym: string, bbo: BboData) => this.handleBboUpdate(sym, bbo));
        this.wsListenerBound = true;
      }
    }
    
    for (const symbol of symbols) {
      this.startSymbol(symbol);
    }
    
    // Start fallback check interval (for stale data)
    if (!this.fallbackIntervalId) {
      this.fallbackIntervalId = setInterval(() => this.checkStaleAndFallback(), CONFIG.FALLBACK_CHECK_INTERVAL_MS);
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
      intervalId: null, // No longer used for polling
      trackedPools: new Map(),
      snapshotHistory: [],
      currentSnapshot: null,
    };

    this.symbolStates.set(symbol, state);

    // Subscribe to WS for this symbol
    if (CONFIG.USE_WS_MARKET_DATA) {
      hyperliquidWsClient.subscribe(symbol);
    }

    // Bootstrap: fetch one initial snapshot via HTTP fallback
    this.captureSnapshotFallback(symbol);

    logger.info(`[MultiSymbolTracker] Started tracking ${symbol} (WS: ${CONFIG.USE_WS_MARKET_DATA})`);
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
      
      // Unsubscribe from WS
      if (CONFIG.USE_WS_MARKET_DATA) {
        hyperliquidWsClient.unsubscribe(symbol);
      }
      
      // Clean up memory
      this.symbolStates.delete(symbol);
      logger.info(`[MultiSymbolTracker] Stopped tracking ${symbol} and cleaned up memory`);
    }
  }

  /**
   * Stop all tracking
   */
  stopAll(): void {
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = null;
    }
    
    for (const symbol of this.symbolStates.keys()) {
      this.stopSymbol(symbol);
    }
    
    // Disconnect WS
    if (CONFIG.USE_WS_MARKET_DATA) {
      hyperliquidWsClient.disconnect();
    }
  }

  /**
   * Handle BBO update from WebSocket
   */
  private handleBboUpdate(symbol: string, bbo: BboData): void {
    const state = this.symbolStates.get(symbol);
    if (!state || !state.isRunning) return;

    const timestamp = Date.now();
    const currentPrice = bbo.mid;
    // bestBid/bestAsk available in bbo.bestBid/bbo.bestAsk if needed

    // Create minimal snapshot from BBO data
    // Note: We don't have full order book depth from WS, just BBO
    const totalBidLiquidity = state.currentSnapshot?.totalBidLiquidity || 0;
    const totalAskLiquidity = state.currentSnapshot?.totalAskLiquidity || 0;
    const liquidityDelta = totalBidLiquidity - totalAskLiquidity;
    const previousDelta = state.currentSnapshot?.liquidityDelta || liquidityDelta;
    const deltaChange = liquidityDelta - previousDelta;

    // Analyze wave from history
    const { waveDirection, waveStrength, waveMomentum } = this.analyzeWave(state);

    const snapshot: SymbolSnapshot = {
      timestamp,
      symbol,
      currentPrice,
      bidPools: state.currentSnapshot?.bidPools || [],
      askPools: state.currentSnapshot?.askPools || [],
      waveDirection,
      waveStrength,
      waveMomentum,
      totalBidLiquidity,
      totalAskLiquidity,
      liquidityDelta,
      deltaChange,
    };

    state.currentSnapshot = snapshot;
    state.snapshotHistory.push(snapshot);

    // Keep only recent snapshots
    if (state.snapshotHistory.length > CONFIG.WAVE_HISTORY_LENGTH) {
      state.snapshotHistory.shift();
    }

    // Emit event for trade loop
    this.emit('snapshot', { symbol, snapshot });
  }

  /**
   * Check for stale data and trigger HTTP fallback if needed
   */
  private async checkStaleAndFallback(): Promise<void> {
    for (const [symbol, state] of this.symbolStates) {
      if (!state.isRunning) continue;

      const isStale = CONFIG.USE_WS_MARKET_DATA 
        ? hyperliquidWsClient.isStale(symbol, CONFIG.DATA_STALE_MS)
        : true; // Always stale if WS disabled

      if (isStale) {
        logger.debug(`[MultiSymbolTracker] ${symbol} data is stale, triggering HTTP fallback`);
        await this.captureSnapshotFallback(symbol);
      }
    }
  }

  /**
   * Capture snapshot via HTTP fallback (rate-limited)
   */
  private async captureSnapshotFallback(symbol: string): Promise<void> {
    const state = this.symbolStates.get(symbol);
    if (!state || !state.isRunning) return;

    try {
      const orderBook = await hyperliquidService.getOrderBookFallback(symbol, CONFIG.ORDER_BOOK_DEPTH);
      
      if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
        return;
      }

      const bestBid = orderBook.bids[0].price;
      const bestAsk = orderBook.asks[0].price;
      const currentPrice = (bestBid + bestAsk) / 2;
      const timestamp = Date.now();

      // Identify pools (simplified - no spoofing detection)
      const currentBidPools = this.identifyPools(symbol, orderBook.bids, currentPrice, 'BID', timestamp);
      const currentAskPools = this.identifyPools(symbol, orderBook.asks, currentPrice, 'ASK', timestamp);

      // Calculate wave analysis
      const { waveDirection, waveStrength, waveMomentum } = this.analyzeWave(state);

      // Calculate stats
      const totalBidLiquidity = orderBook.bids.reduce((sum, l) => sum + l.size, 0);
      const totalAskLiquidity = orderBook.asks.reduce((sum, l) => sum + l.size, 0);
      const liquidityDelta = totalBidLiquidity - totalAskLiquidity;
      const previousDelta = state.currentSnapshot?.liquidityDelta || liquidityDelta;
      const deltaChange = liquidityDelta - previousDelta;

      const snapshot: SymbolSnapshot = {
        timestamp,
        symbol,
        currentPrice,
        bidPools: currentBidPools,
        askPools: currentAskPools,
        waveDirection,
        waveStrength,
        waveMomentum,
        totalBidLiquidity,
        totalAskLiquidity,
        liquidityDelta,
        deltaChange,
      };

      state.currentSnapshot = snapshot;
      state.snapshotHistory.push(snapshot);

      if (state.snapshotHistory.length > CONFIG.WAVE_HISTORY_LENGTH) {
        state.snapshotHistory.shift();
      }

      this.emit('snapshot', { symbol, snapshot });
      logger.debug(`[MultiSymbolTracker] ${symbol} fallback snapshot captured`);

    } catch (error) {
      logger.debug(`[MultiSymbolTracker] Error capturing ${symbol} fallback snapshot: ${error}`);
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
   * Get tracking status
   */
  getStatus(): { symbols: string[]; running: string[]; stopped: string[] } {
    const symbols = Array.from(this.symbolStates.keys());
    const running = symbols.filter(s => this.symbolStates.get(s)?.isRunning);
    const stopped = symbols.filter(s => !this.symbolStates.get(s)?.isRunning);
    return { symbols, running, stopped };
  }

  // ========================================
  // DEPRECATED STUBS (for dashboard compatibility)
  // These methods return empty data - spoofing detection removed
  // ========================================
  
  /** @deprecated Spoofing detection removed */
  getAntiSpoofingSignal(_symbol: string): { 
    action: 'WAIT'; 
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
    } 
  } {
    return {
      action: 'WAIT',
      confidence: 0,
      reasoning: 'Spoofing detection disabled',
      details: {
        askSpoofCount: 0, 
        bidSpoofCount: 0,
        askSpoofVolume: 0, 
        bidSpoofVolume: 0,
        spoofRatio: 0, 
        highConfidenceAlerts: 0,
        currentPrice: this.symbolStates.get(_symbol)?.currentSnapshot?.currentPrice || 0,
      },
    };
  }

  /** @deprecated Spoofing detection removed */
  getSpoofingAlerts(_symbol: string): never[] {
    return [];
  }

  /** @deprecated Spoofing detection removed */
  getAllSignals(): Record<string, ReturnType<MultiSymbolLiquidityTracker['getAntiSpoofingSignal']>> {
    const result: Record<string, ReturnType<MultiSymbolLiquidityTracker['getAntiSpoofingSignal']>> = {};
    for (const symbol of this.symbolStates.keys()) {
      result[symbol] = this.getAntiSpoofingSignal(symbol);
    }
    return result;
  }

  /** @deprecated Spoofing detection removed */
  getAllSpoofingAlerts(): Record<string, never[]> {
    const result: Record<string, never[]> = {};
    for (const symbol of this.symbolStates.keys()) {
      result[symbol] = [];
    }
    return result;
  }
}

export const multiSymbolTracker = new MultiSymbolLiquidityTracker();
export default multiSymbolTracker;
