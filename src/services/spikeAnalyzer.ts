import { logger } from '../core/logger';
import { EventEmitter } from 'events';
import hyperliquidService from './hyperliquidService';
import { liquidityTracker } from './liquidityTracker';
import fs from 'fs/promises';
import path from 'path';

/**
 * SPIKE ANALYZER SERVICE
 * 
 * Analizza le variazioni di prezzo in tempo reale per:
 * 1. Rilevare spike (movimenti rapidi significativi)
 * 2. Identificare pattern che precedono gli spike
 * 3. Generare segnali predittivi basati su pattern storici
 * 4. Salvare dati per analisi successiva
 */

// ========================================
// TYPES
// ========================================

export interface PriceTick {
  timestamp: number;
  price: number;
  volume?: number;
  bidAskSpread?: number;
}

export interface PriceWindow {
  startTime: number;
  endTime: number;
  ticks: PriceTick[];
  
  // Statistiche calcolate
  open: number;
  high: number;
  low: number;
  close: number;
  priceChange: number;
  priceChangePercent: number;
  volatility: number;
  avgVolume: number;
  tickCount: number;
}

export interface SpikeEvent {
  id: string;
  timestamp: number;
  direction: 'UP' | 'DOWN';
  magnitude: number;           // % di movimento
  duration: number;            // ms per raggiungere il picco
  preBehavior: PreSpikeBehavior;
  postBehavior: PostSpikeBehavior | null;
  recovered: boolean;          // Se il prezzo è tornato al livello pre-spike
}

export interface PreSpikeBehavior {
  // 30 secondi prima dello spike
  priceRange: number;          // Range % nei 30s precedenti
  volatility: number;          // Deviazione standard
  momentum: number;            // Direzione del movimento (-1 a 1)
  liquidityImbalance: number;  // Bid vs Ask
  volumeSpike: boolean;        // Volume anomalo
  compressionLevel: number;    // Quanto era "compresso" il prezzo (0-100)
}

export interface PostSpikeBehavior {
  // 30 secondi dopo lo spike
  retracement: number;         // % di ritracciamento
  continuation: number;        // % di continuazione
  stabilized: boolean;         // Se si è stabilizzato
}

export interface SpikePattern {
  id: string;
  name: string;
  description: string;
  occurrences: number;
  winRate: number;             // % di volte che ha portato a profitto
  avgMagnitude: number;
  conditions: PatternConditions;
}

export interface PatternConditions {
  minCompression: number;
  maxVolatility: number;
  minLiquidityImbalance: number;
  momentumRange: [number, number];
  requiredVolumeSpike: boolean;
}

export interface SpikeSignal {
  timestamp: number;
  type: 'SPIKE_IMMINENT' | 'SPIKE_IN_PROGRESS' | 'POST_SPIKE_ENTRY';
  direction: 'UP' | 'DOWN' | 'UNKNOWN';
  confidence: number;
  matchedPattern: string | null;
  reasoning: string;
  suggestedAction: 'BUY' | 'SELL' | 'WAIT';
  targetMove: number;          // % movimento atteso
}

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // Data collection
  TICK_INTERVAL_MS: 500,       // Ogni 500ms
  WINDOW_SIZE_MS: 5 * 60 * 1000, // 5 minuti di finestra
  PRE_SPIKE_WINDOW_MS: 30 * 1000, // 30 secondi prima
  POST_SPIKE_WINDOW_MS: 30 * 1000, // 30 secondi dopo
  
  // Spike detection
  MIN_SPIKE_PERCENT: 0.15,     // Movimento minimo per essere spike (0.15%)
  SPIKE_TIME_WINDOW_MS: 5000,  // Spike deve avvenire in 5 secondi
  
  // Pattern detection
  MIN_PATTERN_OCCURRENCES: 3,  // Minimo occorrenze per pattern valido
  COMPRESSION_THRESHOLD: 0.05, // Range % che indica compressione
  
  // Storage
  DATA_DIR: './logs/spike-data',
  MAX_HISTORY_HOURS: 24,       // Mantieni 24 ore di storia
};

// ========================================
// SPIKE ANALYZER CLASS
// ========================================

class SpikeAnalyzer extends EventEmitter {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private symbol = 'BTC-USDC';
  
  // Data storage
  private priceTicks: PriceTick[] = [];
  private spikeEvents: SpikeEvent[] = [];
  private patterns: Map<string, SpikePattern> = new Map();
  
  // Current analysis
  private lastPrice = 0;
  private currentSignal: SpikeSignal | null = null;
  
  constructor() {
    super();
    this.initializePatterns();
  }
  
  /**
   * Initialize known spike patterns
   */
  private initializePatterns(): void {
    // Pattern 1: Compression Breakout
    this.patterns.set('compression_breakout', {
      id: 'compression_breakout',
      name: 'Compression Breakout',
      description: 'Prezzo compresso in range stretto, poi esplode',
      occurrences: 0,
      winRate: 0,
      avgMagnitude: 0.3,
      conditions: {
        minCompression: 70,
        maxVolatility: 0.03,
        minLiquidityImbalance: 0.3,
        momentumRange: [-0.2, 0.2],
        requiredVolumeSpike: false,
      },
    });
    
    // Pattern 2: Liquidity Sweep
    this.patterns.set('liquidity_sweep', {
      id: 'liquidity_sweep',
      name: 'Liquidity Sweep',
      description: 'Spike rapido che prende liquidità e inverte',
      occurrences: 0,
      winRate: 0,
      avgMagnitude: 0.25,
      conditions: {
        minCompression: 30,
        maxVolatility: 0.1,
        minLiquidityImbalance: 0.5,
        momentumRange: [-1, 1],
        requiredVolumeSpike: true,
      },
    });
    
    // Pattern 3: Momentum Acceleration
    this.patterns.set('momentum_acceleration', {
      id: 'momentum_acceleration',
      name: 'Momentum Acceleration',
      description: 'Trend accelera improvvisamente',
      occurrences: 0,
      winRate: 0,
      avgMagnitude: 0.4,
      conditions: {
        minCompression: 0,
        maxVolatility: 0.15,
        minLiquidityImbalance: 0.2,
        momentumRange: [0.5, 1],
        requiredVolumeSpike: false,
      },
    });
    
    // Pattern 4: Volume Spike
    this.patterns.set('volume_spike', {
      id: 'volume_spike',
      name: 'Volume Spike',
      description: 'Volume anomalo precede movimento',
      occurrences: 0,
      winRate: 0,
      avgMagnitude: 0.35,
      conditions: {
        minCompression: 0,
        maxVolatility: 0.2,
        minLiquidityImbalance: 0.1,
        momentumRange: [-1, 1],
        requiredVolumeSpike: true,
      },
    });
  }
  
  /**
   * Start the analyzer
   */
  start(symbol: string = 'BTC-USDC'): void {
    if (this.isRunning) {
      logger.warn('Spike analyzer already running');
      return;
    }
    
    this.symbol = symbol;
    this.isRunning = true;
    
    logger.info(`🔬 Starting Spike Analyzer for ${symbol}`);
    
    // Load historical data
    this.loadHistoricalData();
    
    // Start tick collection
    this.intervalId = setInterval(() => {
      this.collectTick();
    }, CONFIG.TICK_INTERVAL_MS);
    
    // Analyze every 5 seconds
    setInterval(() => {
      this.analyzeCurrentConditions();
    }, 5000);
  }
  
  /**
   * Stop the analyzer
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    this.saveData();
    logger.info('Spike analyzer stopped');
  }
  
  /**
   * Collect a price tick
   */
  private async collectTick(): Promise<void> {
    try {
      const price = await hyperliquidService.getTickerPrice(this.symbol);
      if (!price || price <= 0) return;
      
      const tick: PriceTick = {
        timestamp: Date.now(),
        price,
      };
      
      // Add liquidity data if available
      const snapshot = liquidityTracker.getCurrentSnapshot();
      if (snapshot) {
        tick.bidAskSpread = snapshot.totalAskLiquidity > 0 
          ? snapshot.totalBidLiquidity / snapshot.totalAskLiquidity 
          : 1;
      }
      
      this.priceTicks.push(tick);
      
      // Keep only recent ticks (5 minutes + buffer)
      const cutoff = Date.now() - CONFIG.WINDOW_SIZE_MS - 60000;
      this.priceTicks = this.priceTicks.filter(t => t.timestamp > cutoff);
      
      // Check for spike
      if (this.lastPrice > 0) {
        const priceChange = (price - this.lastPrice) / this.lastPrice * 100;
        if (Math.abs(priceChange) >= CONFIG.MIN_SPIKE_PERCENT) {
          this.detectSpike(tick, priceChange);
        }
      }
      
      this.lastPrice = price;
      
    } catch (error) {
      // Silent fail - will retry next tick
    }
  }
  
  /**
   * Detect and record a spike event
   */
  private detectSpike(tick: PriceTick, priceChange: number): void {
    const direction = priceChange > 0 ? 'UP' : 'DOWN';
    
    // Get pre-spike behavior
    const preBehavior = this.analyzePreSpikeBehavior();
    
    const spike: SpikeEvent = {
      id: `spike_${Date.now()}`,
      timestamp: tick.timestamp,
      direction,
      magnitude: Math.abs(priceChange),
      duration: CONFIG.TICK_INTERVAL_MS, // Will be updated
      preBehavior,
      postBehavior: null,
      recovered: false,
    };
    
    this.spikeEvents.push(spike);
    
    // Analyze post-spike after delay
    setTimeout(() => {
      this.analyzePostSpikeBehavior(spike);
    }, CONFIG.POST_SPIKE_WINDOW_MS);
    
    // Match to pattern
    const matchedPattern = this.matchToPattern(preBehavior, direction);
    if (matchedPattern) {
      this.updatePatternStats(matchedPattern, spike);
    }
    
    logger.info(`🚀 SPIKE DETECTED: ${direction} ${Math.abs(priceChange).toFixed(3)}%`, {
      magnitude: spike.magnitude,
      compression: preBehavior.compressionLevel,
      momentum: preBehavior.momentum,
      pattern: matchedPattern?.name || 'Unknown',
    });
    
    this.emit('spike', spike);
  }
  
  /**
   * Analyze conditions before spike
   */
  private analyzePreSpikeBehavior(): PreSpikeBehavior {
    const now = Date.now();
    const windowStart = now - CONFIG.PRE_SPIKE_WINDOW_MS;
    const recentTicks = this.priceTicks.filter(t => t.timestamp >= windowStart);
    
    if (recentTicks.length < 10) {
      return {
        priceRange: 0,
        volatility: 0,
        momentum: 0,
        liquidityImbalance: 0,
        volumeSpike: false,
        compressionLevel: 0,
      };
    }
    
    const prices = recentTicks.map(t => t.price);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    
    // Price range as percentage
    const priceRange = avgPrice > 0 ? ((high - low) / avgPrice) * 100 : 0;
    
    // Volatility (standard deviation)
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
    const volatility = Math.sqrt(variance) / avgPrice * 100;
    
    // Momentum (-1 to 1)
    const firstHalf = prices.slice(0, Math.floor(prices.length / 2));
    const secondHalf = prices.slice(Math.floor(prices.length / 2));
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const momentum = avgPrice > 0 ? (secondAvg - firstAvg) / avgPrice * 100 : 0;
    
    // Liquidity imbalance from liquidityTracker
    const snapshot = liquidityTracker.getCurrentSnapshot();
    const liquidityImbalance = snapshot 
      ? (snapshot.totalBidLiquidity - snapshot.totalAskLiquidity) / 
        (snapshot.totalBidLiquidity + snapshot.totalAskLiquidity + 1)
      : 0;
    
    // Compression level (0-100, higher = more compressed)
    const compressionLevel = Math.max(0, Math.min(100, 
      100 - (priceRange / CONFIG.COMPRESSION_THRESHOLD) * 100
    ));
    
    return {
      priceRange,
      volatility,
      momentum: Math.max(-1, Math.min(1, momentum)),
      liquidityImbalance,
      volumeSpike: false, // TODO: implement volume analysis
      compressionLevel,
    };
  }
  
  /**
   * Analyze behavior after spike
   */
  private analyzePostSpikeBehavior(spike: SpikeEvent): void {
    const now = Date.now();
    const spikeTime = spike.timestamp;
    
    // Get ticks after spike
    const postTicks = this.priceTicks.filter(t => 
      t.timestamp > spikeTime && t.timestamp <= now
    );
    
    if (postTicks.length < 5) return;
    
    const spikePrice = this.priceTicks.find(t => t.timestamp === spikeTime)?.price || this.lastPrice;
    const currentPrice = postTicks[postTicks.length - 1].price;
    const preSpikePrice = this.priceTicks.find(t => t.timestamp < spikeTime)?.price || spikePrice;
    
    // Calculate retracement
    const totalMove = spikePrice - preSpikePrice;
    const currentMove = currentPrice - preSpikePrice;
    const retracement = totalMove !== 0 ? (1 - currentMove / totalMove) * 100 : 0;
    
    // Continuation
    const continuation = spike.direction === 'UP' 
      ? (currentPrice > spikePrice ? (currentPrice - spikePrice) / spikePrice * 100 : 0)
      : (currentPrice < spikePrice ? (spikePrice - currentPrice) / spikePrice * 100 : 0);
    
    spike.postBehavior = {
      retracement: Math.max(0, retracement),
      continuation,
      stabilized: Math.abs(currentPrice - spikePrice) / spikePrice < 0.0005,
    };
    
    spike.recovered = retracement > 80;
    
    // Update pattern win rates
    this.updatePatternWinRate(spike);
  }
  
  /**
   * Match current conditions to known patterns
   */
  private matchToPattern(behavior: PreSpikeBehavior, _direction: 'UP' | 'DOWN'): SpikePattern | null {
    let bestMatch: SpikePattern | null = null;
    let bestScore = 0;
    
    for (const [_, pattern] of this.patterns) {
      const cond = pattern.conditions;
      let score = 0;
      let matches = 0;
      
      // Check compression
      if (behavior.compressionLevel >= cond.minCompression) {
        matches++;
        score += behavior.compressionLevel / 100;
      }
      
      // Check volatility
      if (behavior.volatility <= cond.maxVolatility) {
        matches++;
        score += 1 - (behavior.volatility / cond.maxVolatility);
      }
      
      // Check liquidity imbalance
      if (Math.abs(behavior.liquidityImbalance) >= cond.minLiquidityImbalance) {
        matches++;
        score += Math.abs(behavior.liquidityImbalance);
      }
      
      // Check momentum range
      if (behavior.momentum >= cond.momentumRange[0] && behavior.momentum <= cond.momentumRange[1]) {
        matches++;
        score += 1;
      }
      
      // Check volume spike (if required)
      if (!cond.requiredVolumeSpike || behavior.volumeSpike) {
        matches++;
        score += behavior.volumeSpike ? 1 : 0.5;
      }
      
      // Need at least 3/5 conditions
      if (matches >= 3 && score > bestScore) {
        bestScore = score;
        bestMatch = pattern;
      }
    }
    
    return bestMatch;
  }
  
  /**
   * Update pattern statistics
   */
  private updatePatternStats(pattern: SpikePattern, spike: SpikeEvent): void {
    pattern.occurrences++;
    pattern.avgMagnitude = (pattern.avgMagnitude * (pattern.occurrences - 1) + spike.magnitude) / pattern.occurrences;
  }
  
  /**
   * Update pattern win rate based on post-spike behavior
   */
  private updatePatternWinRate(spike: SpikeEvent): void {
    // A "win" is if the spike continued (didn't fully retrace)
    const isWin = spike.postBehavior && spike.postBehavior.retracement < 50;
    
    const matchedPattern = this.matchToPattern(spike.preBehavior, spike.direction);
    if (matchedPattern && matchedPattern.occurrences > 0) {
      const currentWins = matchedPattern.winRate * matchedPattern.occurrences / 100;
      const newWins = isWin ? currentWins + 1 : currentWins;
      matchedPattern.winRate = (newWins / matchedPattern.occurrences) * 100;
    }
  }
  
  /**
   * Analyze current conditions for potential spike
   */
  private analyzeCurrentConditions(): void {
    const behavior = this.analyzePreSpikeBehavior();
    
    // Check for pattern matches
    let highestConfidence = 0;
    let likelyDirection: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
    let matchedPatternName: string | null = null;
    
    // Predict direction from liquidity imbalance
    if (behavior.liquidityImbalance > 0.3) {
      likelyDirection = 'UP'; // More bid pressure
    } else if (behavior.liquidityImbalance < -0.3) {
      likelyDirection = 'DOWN'; // More ask pressure
    } else if (behavior.momentum > 0.3) {
      likelyDirection = 'UP';
    } else if (behavior.momentum < -0.3) {
      likelyDirection = 'DOWN';
    }
    
    // Check each pattern
    for (const [_, pattern] of this.patterns) {
      const cond = pattern.conditions;
      
      // Calculate match score
      let matchScore = 0;
      
      if (behavior.compressionLevel >= cond.minCompression) {
        matchScore += 25;
      }
      if (behavior.volatility <= cond.maxVolatility) {
        matchScore += 20;
      }
      if (Math.abs(behavior.liquidityImbalance) >= cond.minLiquidityImbalance) {
        matchScore += 25;
      }
      if (behavior.momentum >= cond.momentumRange[0] && behavior.momentum <= cond.momentumRange[1]) {
        matchScore += 20;
      }
      if (!cond.requiredVolumeSpike) {
        matchScore += 10;
      }
      
      // Weight by historical win rate
      const adjustedScore = matchScore * (pattern.winRate > 0 ? pattern.winRate / 100 : 0.5);
      
      if (adjustedScore > highestConfidence) {
        highestConfidence = adjustedScore;
        matchedPatternName = pattern.name;
      }
    }
    
    // Generate signal if confidence is high enough
    if (highestConfidence >= 50 && likelyDirection !== 'UNKNOWN') {
      this.currentSignal = {
        timestamp: Date.now(),
        type: behavior.compressionLevel > 70 ? 'SPIKE_IMMINENT' : 'POST_SPIKE_ENTRY',
        direction: likelyDirection,
        confidence: Math.min(95, highestConfidence),
        matchedPattern: matchedPatternName,
        reasoning: this.generateReasoning(behavior, matchedPatternName, likelyDirection),
        suggestedAction: likelyDirection === 'UP' ? 'BUY' : 'SELL',
        targetMove: 0.2, // Conservative target
      };
      
      this.emit('signal', this.currentSignal);
      
      logger.debug('📊 Spike signal generated', {
        direction: likelyDirection,
        confidence: highestConfidence,
        pattern: matchedPatternName || 'none',
        compression: behavior.compressionLevel,
      });
    } else {
      this.currentSignal = null;
    }
  }
  
  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(behavior: PreSpikeBehavior, pattern: string | null, direction: 'UP' | 'DOWN'): string {
    const parts: string[] = [];
    
    if (behavior.compressionLevel > 70) {
      parts.push(`Price compressed (${behavior.compressionLevel.toFixed(0)}%)`);
    }
    if (behavior.volatility < 0.05) {
      parts.push('Low volatility');
    }
    if (Math.abs(behavior.liquidityImbalance) > 0.3) {
      parts.push(`Liquidity ${behavior.liquidityImbalance > 0 ? 'bid' : 'ask'} heavy`);
    }
    if (pattern) {
      parts.push(`Pattern: ${pattern}`);
    }
    
    return parts.length > 0 
      ? `${direction} spike likely: ${parts.join(', ')}`
      : `Conditions favor ${direction} movement`;
  }
  
  /**
   * Get current signal
   */
  getCurrentSignal(): SpikeSignal | null {
    return this.currentSignal;
  }
  
  /**
   * Get spike recommendation for trading
   */
  getSpikeRecommendation(): {
    action: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    reasoning: string;
    pattern: string | null;
  } {
    if (!this.currentSignal || this.currentSignal.confidence < 60) {
      return {
        action: 'WAIT',
        confidence: 0,
        reasoning: 'No clear spike pattern detected',
        pattern: null,
      };
    }
    
    return {
      action: this.currentSignal.suggestedAction,
      confidence: this.currentSignal.confidence,
      reasoning: this.currentSignal.reasoning,
      pattern: this.currentSignal.matchedPattern,
    };
  }
  
  /**
   * Get analysis data for dashboard
   */
  getAnalysisData(): {
    currentBehavior: PreSpikeBehavior;
    recentSpikes: SpikeEvent[];
    patterns: SpikePattern[];
    priceWindow: PriceWindow | null;
    signal: SpikeSignal | null;
  } {
    const behavior = this.analyzePreSpikeBehavior();
    const recentSpikes = this.spikeEvents.slice(-20);
    const patterns = Array.from(this.patterns.values());
    
    // Create 5-min price window
    const windowTicks = this.priceTicks.filter(t => 
      t.timestamp > Date.now() - CONFIG.WINDOW_SIZE_MS
    );
    
    let priceWindow: PriceWindow | null = null;
    if (windowTicks.length > 0) {
      const prices = windowTicks.map(t => t.price);
      priceWindow = {
        startTime: windowTicks[0].timestamp,
        endTime: windowTicks[windowTicks.length - 1].timestamp,
        ticks: windowTicks,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        priceChange: prices[prices.length - 1] - prices[0],
        priceChangePercent: ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100,
        volatility: behavior.volatility,
        avgVolume: 0,
        tickCount: windowTicks.length,
      };
    }
    
    return {
      currentBehavior: behavior,
      recentSpikes,
      patterns,
      priceWindow,
      signal: this.currentSignal,
    };
  }
  
  /**
   * Get price ticks for charting
   */
  getPriceTicks(minutes: number = 5): PriceTick[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.priceTicks.filter(t => t.timestamp > cutoff);
  }
  
  /**
   * Save data to file
   */
  private async saveData(): Promise<void> {
    try {
      await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
      
      const data = {
        timestamp: Date.now(),
        symbol: this.symbol,
        spikeEvents: this.spikeEvents.slice(-100),
        patterns: Array.from(this.patterns.entries()),
      };
      
      const filename = path.join(CONFIG.DATA_DIR, `spike-data-${new Date().toISOString().split('T')[0]}.json`);
      await fs.writeFile(filename, JSON.stringify(data, null, 2));
      
      logger.debug('Spike data saved');
    } catch (error) {
      logger.error('Failed to save spike data', error);
    }
  }
  
  /**
   * Load historical data
   */
  private async loadHistoricalData(): Promise<void> {
    try {
      const files = await fs.readdir(CONFIG.DATA_DIR).catch(() => []);
      
      for (const file of files.slice(-3)) { // Last 3 days
        const filepath = path.join(CONFIG.DATA_DIR, file);
        const content = await fs.readFile(filepath, 'utf-8');
        const data = JSON.parse(content);
        
        // Merge spike events
        if (data.spikeEvents) {
          this.spikeEvents.push(...data.spikeEvents);
        }
        
        // Update patterns
        if (data.patterns) {
          for (const [id, pattern] of data.patterns) {
            const existing = this.patterns.get(id);
            if (existing) {
              existing.occurrences += pattern.occurrences;
              existing.avgMagnitude = (existing.avgMagnitude + pattern.avgMagnitude) / 2;
              existing.winRate = (existing.winRate + pattern.winRate) / 2;
            }
          }
        }
      }
      
      // Keep only recent spikes
      const cutoff = Date.now() - CONFIG.MAX_HISTORY_HOURS * 60 * 60 * 1000;
      this.spikeEvents = this.spikeEvents.filter(s => s.timestamp > cutoff);
      
      logger.info(`Loaded ${this.spikeEvents.length} historical spike events`);
    } catch (error) {
      logger.debug('No historical spike data found');
    }
  }
}

export const spikeAnalyzer = new SpikeAnalyzer();
export default spikeAnalyzer;
