import { logger } from '../core/logger';
import hyperliquidService from './hyperliquidService';
import { EventEmitter } from 'events';
import { spooferProfiler } from './spooferProfiler';

/**
 * LIQUIDITY TRACKER SERVICE
 * 
 * Monitora continuamente la liquidità nell'order book e:
 * 1. Traccia i liquidity pools nel tempo
 * 2. Rileva ordini fantasma (spoofing)
 * 3. Calcola la "wave" direction - dove sta andando la liquidità
 * 4. Fornisce dati real-time per la dashboard
 */

// ========================================
// TYPES
// ========================================

export interface TrackedLiquidityPool {
  id: string;
  priceLevel: number;
  side: 'BID' | 'ASK';
  totalSize: number;
  orderCount: number;
  distancePercent: number;
  magnetScore: number;
  
  // Tracking nel tempo
  firstSeen: number;
  lastSeen: number;
  sizeHistory: { timestamp: number; size: number }[];
  
  // Spoofing detection
  disappearances: number;      // Quante volte è sparito e riapparso
  isLikelySpoofing: boolean;
  stabilityScore: number;      // 0-100, più alto = più stabile/affidabile
}

export interface LiquiditySnapshot {
  timestamp: number;
  symbol: string;
  currentPrice: number;
  
  // Pools attivi
  bidPools: TrackedLiquidityPool[];
  askPools: TrackedLiquidityPool[];
  
  // Wave analysis
  waveDirection: 'UP' | 'DOWN' | 'NEUTRAL';
  waveStrength: number;        // 0-100
  waveMomentum: number;        // Cambio negli ultimi N secondi
  
  // Ordini fantasma rilevati
  spoofingAlerts: SpoofingAlert[];
  
  // Statistiche generali
  totalBidLiquidity: number;
  totalAskLiquidity: number;
  liquidityDelta: number;       // bid - ask
  deltaChange: number;          // Cambio del delta rispetto a prima
}

export interface SpoofingAlert {
  timestamp: number;
  priceLevel: number;
  side: 'BID' | 'ASK';
  originalSize: number;
  disappearedSize: number;
  confidence: number;           // 0-100 confidence che sia spoofing
  message: string;
}

export interface SystemOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'stop';
  price: number;
  quantity: number;
  status: 'pending' | 'partially_filled' | 'filled' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  filledQuantity: number;
  reasoning: string;
}

// ========================================
// TIMEFRAME CONFIGURATIONS
// ========================================

export interface TimeframeConfig {
  name: string;
  maxDistancePercent: number;      // Quanto lontano dal prezzo guardare
  clusterDistancePercent: number;  // Distanza per raggruppare livelli in cluster
  orderBookDepth: number;          // Quanti livelli richiedere
  minPoolSizeMultiplier: number;   // Moltiplicatore per size minima pool
}

const TIMEFRAME_CONFIGS: Record<string, TimeframeConfig> = {
  'scalping': {
    name: 'Scalping (1-5m)',
    maxDistancePercent: 0.3,       // ±0.3% dal prezzo
    clusterDistancePercent: 0.05,
    orderBookDepth: 50,
    minPoolSizeMultiplier: 1.5,
  },
  'short': {
    name: 'Short Term (5-15m)',
    maxDistancePercent: 0.8,       // ±0.8% dal prezzo
    clusterDistancePercent: 0.1,
    orderBookDepth: 100,
    minPoolSizeMultiplier: 1.5,
  },
  'medium': {
    name: 'Medium Term (15m-1h)',
    maxDistancePercent: 1.5,       // ±1.5% dal prezzo
    clusterDistancePercent: 0.15,
    orderBookDepth: 150,
    minPoolSizeMultiplier: 1.3,
  },
  'swing': {
    name: 'Swing (1h-4h)',
    maxDistancePercent: 3.0,       // ±3% dal prezzo
    clusterDistancePercent: 0.25,
    orderBookDepth: 200,
    minPoolSizeMultiplier: 1.2,
  },
};

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // Tracking intervals
  SNAPSHOT_INTERVAL_MS: 500,      // Ogni 500ms cattura snapshot
  POOL_MEMORY_MS: 30000,          // Ricorda pool per 30 secondi
  
  // Pool detection - DEFAULT (sarà sovrascritto dal timeframe)
  CLUSTER_DISTANCE_PERCENT: 0.1,
  MIN_POOL_SIZE_MULTIPLIER: 1.3,  // Abbassato per vedere più pool
  MIN_ORDERS_IN_POOL: 1,          // Anche singoli ordini grandi
  MAX_DISTANCE_PERCENT: 2.0,      // Default 2% - ampliato
  ORDER_BOOK_DEPTH: 100,          // Più livelli dall'order book
  
  // Spoofing detection
  SPOOFING_DISAPPEAR_THRESHOLD: 3,  // 3+ sparizioni = likely spoofing
  SPOOFING_TIME_WINDOW_MS: 5000,    // Finestra per valutare spoofing
  MIN_SIZE_FOR_SPOOFING: 0.3,       // Abbassato per catturare più spoofing
  
  // Wave analysis
  WAVE_HISTORY_LENGTH: 20,          // Ultimi 20 snapshot per wave analysis
  MOMENTUM_WINDOW: 5,               // Ultimi 5 per momentum
};

// ========================================
// LIQUIDITY TRACKER CLASS
// ========================================

class LiquidityTracker extends EventEmitter {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  
  // Tracking data
  private trackedPools: Map<string, TrackedLiquidityPool> = new Map();
  private snapshotHistory: LiquiditySnapshot[] = [];
  private systemOrders: Map<string, SystemOrder> = new Map();
  private spoofingAlerts: SpoofingAlert[] = [];
  
  // Current state
  private currentSnapshot: LiquiditySnapshot | null = null;
  private symbol = 'BTC-USDC';
  
  // Timeframe configuration
  private currentTimeframe: string = 'medium';
  private timeframeConfig: TimeframeConfig = TIMEFRAME_CONFIGS['medium'];
  
  constructor() {
    super();
  }
  
  /**
   * Set timeframe for analysis
   */
  setTimeframe(timeframe: string): void {
    if (TIMEFRAME_CONFIGS[timeframe]) {
      this.currentTimeframe = timeframe;
      this.timeframeConfig = TIMEFRAME_CONFIGS[timeframe];
      logger.info(`[LiquidityTracker] Timeframe changed to ${timeframe}: ${this.timeframeConfig.name}`);
      
      // Clear old pools when changing timeframe
      this.trackedPools.clear();
      this.emit('timeframe:changed', { timeframe, config: this.timeframeConfig });
    }
  }
  
  /**
   * Get current timeframe
   */
  getTimeframe(): { current: string; config: TimeframeConfig; available: Record<string, TimeframeConfig> } {
    return {
      current: this.currentTimeframe,
      config: this.timeframeConfig,
      available: TIMEFRAME_CONFIGS,
    };
  }
  
  /**
   * Start tracking liquidity for a symbol
   */
  start(symbol: string): void {
    if (this.isRunning) {
      logger.warn('[LiquidityTracker] Already running');
      return;
    }
    
    this.symbol = symbol;
    this.isRunning = true;
    
    logger.info(`[LiquidityTracker] Starting for ${symbol} with timeframe: ${this.currentTimeframe}`);
    
    // Run immediately and then at intervals
    this.captureSnapshot();
    this.intervalId = setInterval(() => this.captureSnapshot(), CONFIG.SNAPSHOT_INTERVAL_MS);
  }
  
  /**
   * Stop tracking
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('[LiquidityTracker] Stopped');
  }
  
  /**
   * Capture a snapshot of current liquidity
   */
  private async captureSnapshot(): Promise<void> {
    try {
      // Usa la profondità dell'order book dal timeframe
      const depth = this.timeframeConfig.orderBookDepth;
      const orderBook = await hyperliquidService.getOrderBook(this.symbol, depth);
      
      if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
        logger.debug('[LiquidityTracker] No order book data');
        return;
      }
      
      const bestBid = orderBook.bids[0].price;
      const bestAsk = orderBook.asks[0].price;
      const currentPrice = (bestBid + bestAsk) / 2;
      const timestamp = Date.now();
      
      // Log order book stats per debug
      logger.debug(`[LiquidityTracker] OrderBook: ${orderBook.bids.length} bids, ${orderBook.asks.length} asks, price: $${currentPrice.toFixed(2)}`);
      
      // Identifica pools correnti
      const currentBidPools = this.identifyPools(orderBook.bids, currentPrice, 'BID', timestamp);
      const currentAskPools = this.identifyPools(orderBook.asks, currentPrice, 'ASK', timestamp);
      
      // Log pools trovati
      if (currentBidPools.length > 0 || currentAskPools.length > 0) {
        logger.debug(`[LiquidityTracker] Found ${currentBidPools.length} bid pools, ${currentAskPools.length} ask pools`);
      }
      
      // Aggiorna tracking e rileva spoofing
      const newSpoofingAlerts = this.updateTracking(currentBidPools, currentAskPools, timestamp);
      this.spoofingAlerts.push(...newSpoofingAlerts);
      
      // Mantieni solo alert recenti
      const recentThreshold = timestamp - 60000; // Ultimo minuto
      this.spoofingAlerts = this.spoofingAlerts.filter(a => a.timestamp > recentThreshold);
      
      // Calcola wave analysis
      const { waveDirection, waveStrength, waveMomentum } = this.analyzeWave(
        currentBidPools, currentAskPools
      );
      
      // Calcola statistiche - usa TUTTI i livelli dell'order book per le statistiche totali
      const totalBidLiquidity = orderBook.bids.reduce((sum, l) => sum + l.size, 0);
      const totalAskLiquidity = orderBook.asks.reduce((sum, l) => sum + l.size, 0);
      const liquidityDelta = totalBidLiquidity - totalAskLiquidity;
      
      const previousDelta = this.currentSnapshot?.liquidityDelta || liquidityDelta;
      const deltaChange = liquidityDelta - previousDelta;
      
      // Crea snapshot
      const snapshot: LiquiditySnapshot = {
        timestamp,
        symbol: this.symbol,
        currentPrice,
        bidPools: currentBidPools,
        askPools: currentAskPools,
        waveDirection,
        waveStrength,
        waveMomentum,
        spoofingAlerts: newSpoofingAlerts,
        totalBidLiquidity,
        totalAskLiquidity,
        liquidityDelta,
        deltaChange,
      };
      
      // Salva snapshot
      this.currentSnapshot = snapshot;
      this.snapshotHistory.push(snapshot);
      
      // Mantieni solo ultimi N snapshot
      if (this.snapshotHistory.length > CONFIG.WAVE_HISTORY_LENGTH) {
        this.snapshotHistory.shift();
      }
      
      // Emetti evento per WebSocket
      this.emit('snapshot', snapshot);
      
      // Feed spoofing alerts to profiler for fingerprinting
      if (newSpoofingAlerts.length > 0) {
        spooferProfiler.processAlerts(newSpoofingAlerts);
      }
      
      // Log spoofing alerts
      for (const alert of newSpoofingAlerts) {
        logger.warn(`🚨 [SPOOFING] ${alert.message}`, {
          price: alert.priceLevel,
          side: alert.side,
          size: alert.originalSize,
          confidence: alert.confidence,
        });
      }
      
    } catch (error) {
      logger.error('[LiquidityTracker] Error capturing snapshot', error);
    }
  }
  
  /**
   * Identifica pools dall'order book
   */
  private identifyPools(
    levels: { price: number; size: number }[],
    currentPrice: number,
    side: 'BID' | 'ASK',
    timestamp: number
  ): TrackedLiquidityPool[] {
    if (levels.length === 0) return [];
    
    // Usa parametri dal timeframe corrente
    const maxDistancePercent = this.timeframeConfig.maxDistancePercent;
    
    // Filtra solo livelli entro la distanza massima del timeframe
    const relevantLevels = levels.filter(l => {
      const dist = Math.abs(l.price - currentPrice) / currentPrice * 100;
      return dist <= maxDistancePercent;
    });
    
    if (relevantLevels.length === 0) {
      logger.debug(`[LiquidityTracker] No levels within ${maxDistancePercent}% of price $${currentPrice.toFixed(2)}`);
      return [];
    }
    
    // Calcola statistiche
    const sizes = relevantLevels.map(l => l.size);
    const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const maxSize = Math.max(...sizes);
    
    // Crea pool per OGNI livello significativo (sopra la media)
    // Questo mostra tutti i livelli di prezzo con ordini pendenti rilevanti
    const pools: TrackedLiquidityPool[] = [];
    
    for (const level of relevantLevels) {
      // Includi livelli che sono almeno 50% della media o sopra
      if (level.size >= avgSize * 0.5) {
        const distancePercent = Math.abs(level.price - currentPrice) / currentPrice * 100;
        
        // Calcola magnet score
        const sizeScore = Math.min(level.size / maxSize, 1) * 50;  // 0-50 basato su quanto è grande rispetto al max
        const distanceScore = Math.max(0, 1 - distancePercent / maxDistancePercent) * 30;  // 0-30 più vicino = meglio
        const magnetScore = Math.round(sizeScore + distanceScore + 20);  // +20 base score
        
        const id = `${side}-${level.price.toFixed(2)}`;
        const existing = this.trackedPools.get(id);
        
        pools.push({
          id,
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
        });
      }
    }
    
    // Ritorna i top 15 pool per magnet score (più pool visibili)
    return pools.sort((a, b) => b.magnetScore - a.magnetScore).slice(0, 15);
  }
  
  /**
   * Aggiorna tracking e rileva spoofing
   */
  private updateTracking(
    bidPools: TrackedLiquidityPool[],
    askPools: TrackedLiquidityPool[],
    timestamp: number
  ): SpoofingAlert[] {
    const alerts: SpoofingAlert[] = [];
    const currentPoolIds = new Set<string>();
    
    // Processa tutti i pool correnti
    const allPools = [...bidPools, ...askPools];
    for (const pool of allPools) {
      currentPoolIds.add(pool.id);
      
      const existing = this.trackedPools.get(pool.id);
      if (existing) {
        // Aggiorna history
        pool.sizeHistory = [
          ...existing.sizeHistory.slice(-20),
          { timestamp, size: pool.totalSize }
        ];
        
        // Calcola stability score basato sulla consistenza del size
        const sizes = pool.sizeHistory.map(h => h.size);
        if (sizes.length > 3) {
          const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
          const variance = sizes.reduce((sum, s) => sum + Math.pow(s - avgSize, 2), 0) / sizes.length;
          const stdDev = Math.sqrt(variance);
          const cv = avgSize > 0 ? stdDev / avgSize : 0; // Coefficient of variation
          pool.stabilityScore = Math.max(0, Math.min(100, 100 - cv * 100));
        }
        
        pool.disappearances = existing.disappearances;
        pool.firstSeen = existing.firstSeen;
      }
      
      this.trackedPools.set(pool.id, pool);
    }
    
    // Rileva pool spariti (potenziale spoofing)
    for (const [id, pool] of this.trackedPools) {
      if (!currentPoolIds.has(id)) {
        const timeSinceLastSeen = timestamp - pool.lastSeen;
        
        // Se è sparito entro la finestra di spoofing
        if (timeSinceLastSeen < CONFIG.SPOOFING_TIME_WINDOW_MS) {
          pool.disappearances++;
          
          // Controlla se è spoofing
          if (pool.disappearances >= CONFIG.SPOOFING_DISAPPEAR_THRESHOLD &&
              pool.totalSize >= CONFIG.MIN_SIZE_FOR_SPOOFING) {
            pool.isLikelySpoofing = true;
            pool.stabilityScore = Math.max(0, pool.stabilityScore - 30);
            
            alerts.push({
              timestamp,
              priceLevel: pool.priceLevel,
              side: pool.side,
              originalSize: pool.totalSize,
              disappearedSize: pool.totalSize,
              confidence: Math.min(95, 50 + pool.disappearances * 10),
              message: `Ordine fantasma rilevato @ $${pool.priceLevel.toFixed(2)} (${pool.side}) - sparito ${pool.disappearances}x`,
            });
          }
        }
        
        // Rimuovi pool vecchi
        if (timeSinceLastSeen > CONFIG.POOL_MEMORY_MS) {
          this.trackedPools.delete(id);
        }
      }
    }
    
    return alerts;
  }
  
  /**
   * Analizza la "wave" - direzione del movimento della liquidità
   */
  private analyzeWave(
    bidPools: TrackedLiquidityPool[],
    askPools: TrackedLiquidityPool[]
  ): { waveDirection: 'UP' | 'DOWN' | 'NEUTRAL'; waveStrength: number; waveMomentum: number } {
    const maxDistancePercent = this.timeframeConfig.maxDistancePercent;
    
    // Calcola liquidità totale per lato (pesata per distanza)
    const bidLiquidity = bidPools.reduce((sum, p) => sum + p.totalSize * (1 - p.distancePercent / maxDistancePercent), 0);
    const askLiquidity = askPools.reduce((sum, p) => sum + p.totalSize * (1 - p.distancePercent / maxDistancePercent), 0);
    
    const total = bidLiquidity + askLiquidity;
    if (total === 0) return { waveDirection: 'NEUTRAL', waveStrength: 0, waveMomentum: 0 };
    
    // Ratio determina la direzione
    const bidRatio = bidLiquidity / total;
    const askRatio = askLiquidity / total;
    const imbalance = bidRatio - askRatio; // Positivo = più bid = prezzo sale verso ask pools
    
    // Direzione: più liquidità ASK = prezzo sarà attirato UP
    // più liquidità BID = prezzo sarà attirato DOWN (verso i bid)
    let waveDirection: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (imbalance < -0.15) waveDirection = 'UP';   // Più ask = prezzo sale per cacciarli
    else if (imbalance > 0.15) waveDirection = 'DOWN'; // Più bid = prezzo scende per cacciarli
    
    // Forza basata sull'imbalance
    const waveStrength = Math.min(100, Math.abs(imbalance) * 200);
    
    // Calcola momentum dagli snapshot storici
    let waveMomentum = 0;
    if (this.snapshotHistory.length >= CONFIG.MOMENTUM_WINDOW) {
      const recentSnapshots = this.snapshotHistory.slice(-CONFIG.MOMENTUM_WINDOW);
      const oldDelta = recentSnapshots[0].liquidityDelta;
      const newDelta = recentSnapshots[recentSnapshots.length - 1].liquidityDelta;
      waveMomentum = newDelta - oldDelta;
    }
    
    return { waveDirection, waveStrength, waveMomentum };
  }
  
  /**
   * Get current snapshot
   */
  getCurrentSnapshot(): LiquiditySnapshot | null {
    return this.currentSnapshot;
  }
  
  /**
   * Get snapshot history
   */
  getSnapshotHistory(): LiquiditySnapshot[] {
    return [...this.snapshotHistory];
  }
  
  /**
   * Get recent spoofing alerts
   */
  getSpoofingAlerts(): SpoofingAlert[] {
    return [...this.spoofingAlerts];
  }
  
  /**
   * Add a system order to track
   */
  addSystemOrder(order: SystemOrder): void {
    this.systemOrders.set(order.id, order);
    this.emit('orderAdded', order);
    logger.info(`[LiquidityTracker] System order added: ${order.side} ${order.quantity} @ ${order.price}`);
  }
  
  /**
   * Update system order
   */
  updateSystemOrder(orderId: string, updates: Partial<SystemOrder>): void {
    const order = this.systemOrders.get(orderId);
    if (order) {
      Object.assign(order, updates, { updatedAt: Date.now() });
      this.emit('orderUpdated', order);
    }
  }
  
  /**
   * Remove system order
   */
  removeSystemOrder(orderId: string): void {
    const order = this.systemOrders.get(orderId);
    if (order) {
      this.systemOrders.delete(orderId);
      this.emit('orderRemoved', order);
    }
  }
  
  /**
   * Get all system orders
   */
  getSystemOrders(): SystemOrder[] {
    return Array.from(this.systemOrders.values());
  }
  
  /**
   * Check if we should cancel/move orders based on spoofing
   */
  checkOrdersForSpoofing(): { ordersToCancel: string[]; reason: string } | null {
    const alerts = this.spoofingAlerts.filter(a => 
      Date.now() - a.timestamp < 5000 && a.confidence > 70
    );
    
    if (alerts.length === 0) return null;
    
    const ordersToCancel: string[] = [];
    
    for (const order of this.systemOrders.values()) {
      if (order.status !== 'pending') continue;
      
      // Controlla se l'ordine è vicino a un livello di spoofing
      for (const alert of alerts) {
        const distance = Math.abs(order.price - alert.priceLevel) / order.price * 100;
        if (distance < 0.1) { // Entro 0.1%
          ordersToCancel.push(order.id);
          break;
        }
      }
    }
    
    if (ordersToCancel.length > 0) {
      return {
        ordersToCancel,
        reason: `Spoofing detected near ${ordersToCancel.length} pending order(s)`,
      };
    }
    
    return null;
  }
  
  /**
   * Get "surf" recommendation based on wave
   */
  getSurfRecommendation(): {
    action: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    targetPool: TrackedLiquidityPool | null;
    reasoning: string;
  } {
    if (!this.currentSnapshot) {
      return { action: 'WAIT', confidence: 0, targetPool: null, reasoning: 'No data yet' };
    }
    
    const { waveDirection, waveStrength, bidPools, askPools } = this.currentSnapshot;
    
    // Trova il pool più attraente (escludendo spoofing)
    const allPools = [...bidPools, ...askPools]
      .filter(p => !p.isLikelySpoofing && p.stabilityScore > 50)
      .sort((a, b) => b.magnetScore - a.magnetScore);
    
    if (allPools.length === 0 || waveStrength < 30) {
      return { action: 'WAIT', confidence: 0, targetPool: null, reasoning: 'No clear wave direction' };
    }
    
    const targetPool = allPools[0];
    const action = waveDirection === 'UP' ? 'BUY' : waveDirection === 'DOWN' ? 'SELL' : 'WAIT';
    const confidence = Math.min(95, waveStrength * targetPool.stabilityScore / 100);
    
    return {
      action,
      confidence,
      targetPool,
      reasoning: `Wave ${waveDirection} (${waveStrength}%), target pool @ $${targetPool.priceLevel.toFixed(2)} (stability: ${targetPool.stabilityScore}%)`,
    };
  }

  /**
   * ANTI-SPOOFING STRATEGY
   * Sfrutta lo spoofing massiccio per anticipare il movimento reale
   * 
   * Logica:
   * - ASK spoofing > BID spoofing = Whale vuole ACCUMULARE (comprare cheap) → prezzo salirà → BUY
   * - BID spoofing > ASK spoofing = Whale vuole DISTRIBUIRE (vendere high) → prezzo scenderà → SELL
   */
  getAntiSpoofingSignal(): {
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
  } {
    const recentAlerts = this.spoofingAlerts.filter(a => 
      Date.now() - a.timestamp < 30000 && a.confidence >= 80  // Ultimi 30s, alta confidenza
    );

    if (recentAlerts.length < 3) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: 'Spoofing insufficiente per segnale',
        details: {
          askSpoofCount: 0,
          bidSpoofCount: 0,
          askSpoofVolume: 0,
          bidSpoofVolume: 0,
          spoofRatio: 0,
          highConfidenceAlerts: recentAlerts.length,
          currentPrice: this.currentSnapshot?.currentPrice || 0,
        },
      };
    }

    // Separa per side
    const askSpoof = recentAlerts.filter(a => a.side === 'ASK');
    const bidSpoof = recentAlerts.filter(a => a.side === 'BID');

    const askVolume = askSpoof.reduce((sum, a) => sum + a.originalSize, 0);
    const bidVolume = bidSpoof.reduce((sum, a) => sum + a.originalSize, 0);
    const totalVolume = askVolume + bidVolume;

    if (totalVolume < 1) {  // Meno di 1 BTC di spoofing
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: 'Volume spoofing troppo basso',
        details: {
          askSpoofCount: askSpoof.length,
          bidSpoofCount: bidSpoof.length,
          askSpoofVolume: askVolume,
          bidSpoofVolume: bidVolume,
          spoofRatio: 0,
          highConfidenceAlerts: recentAlerts.length,
          currentPrice: this.currentSnapshot?.currentPrice || 0,
        },
      };
    }

    // Calcola ratio
    const askRatio = askVolume / totalVolume;
    const bidRatio = bidVolume / totalVolume;
    const dominantRatio = Math.max(askRatio, bidRatio);
    
    // Soglia: serve almeno 60% dominanza per segnale
    const MIN_DOMINANCE = 0.60;
    
    let action: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
    let reasoning = '';
    
    if (askRatio >= MIN_DOMINANCE) {
      // Spoofing massiccio ASK = qualcuno piazza sell wall fake per spaventare
      // Real intent: accumulare a prezzi bassi
      // Prediction: prezzo salirà quando rimuove lo spoof
      action = 'BUY';
      reasoning = `🎯 ASK SPOOFING DETECTED (${(askRatio*100).toFixed(0)}%) - Whale accumulating! ` +
                  `Fake sell walls: ${askSpoof.length} alerts, ${askVolume.toFixed(2)} BTC. ` +
                  `Expect upward move when spoof removed.`;
    } else if (bidRatio >= MIN_DOMINANCE) {
      // Spoofing massiccio BID = qualcuno piazza buy wall fake per dare falsa sicurezza
      // Real intent: vendere a prezzi alti mentre retail compra
      // Prediction: prezzo scenderà quando rimuove lo spoof
      action = 'SELL';
      reasoning = `🎯 BID SPOOFING DETECTED (${(bidRatio*100).toFixed(0)}%) - Whale distributing! ` +
                  `Fake buy walls: ${bidSpoof.length} alerts, ${bidVolume.toFixed(2)} BTC. ` +
                  `Expect downward move when spoof removed.`;
    } else {
      reasoning = `Mixed spoofing (ASK: ${(askRatio*100).toFixed(0)}%, BID: ${(bidRatio*100).toFixed(0)}%) - No clear bias`;
    }

    // Confidence basata su: volume, dominanza, numero alerts
    const volumeScore = Math.min(40, totalVolume * 4);  // Max 40 da volume (10+ BTC = max)
    const dominanceScore = (dominantRatio - 0.5) * 80;  // 0-40 da dominanza
    const countScore = Math.min(20, recentAlerts.length * 2);  // Max 20 da count
    const confidence = action !== 'WAIT' ? Math.min(95, volumeScore + dominanceScore + countScore) : 0;

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
        currentPrice: this.currentSnapshot?.currentPrice || 0,
      },
    };
  }
}

export const liquidityTracker = new LiquidityTracker();
export default liquidityTracker;
