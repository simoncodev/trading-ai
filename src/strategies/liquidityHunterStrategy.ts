import { logger } from '../core/logger';
import hyperliquidService from '../services/hyperliquidService';
import { orderBookAnalyzer } from '../services/orderBookAnalyzer';

/**
 * LIQUIDITY HUNTER STRATEGY
 * 
 * Concetto: Il prezzo viene "attirato" verso zone di alta liquidità (liquidity pools)
 * perché i market maker e gli istituzionali vogliono riempire quegli ordini.
 * 
 * Strategia:
 * 1. Identifica cluster di ordini limit (liquidity pools) sopra e sotto il prezzo
 * 2. Determina quale pool è più "attraente" (più liquidità = più attrazione)
 * 3. Segui l'onda: entra nella direzione del pool più grande
 * 4. Esci quando il prezzo raggiunge il pool (liquidità consumata)
 * 
 * Questo è diverso dall'analisi tradizionale:
 * - NON guardiamo l'imbalance attuale
 * - Guardiamo DOVE si trova la liquidità e ci aspettiamo che il prezzo ci vada
 */

// ========================================
// TYPES
// ========================================

export interface LiquidityPool {
  priceLevel: number;           // Prezzo centrale del pool
  totalSize: number;            // Volume totale nel cluster
  orderCount: number;           // Numero di ordini nel cluster
  distancePercent: number;      // Distanza dal prezzo attuale (%)
  magnetScore: number;          // Score di "attrazione" (0-100)
  side: 'BID' | 'ASK';         // Lato del book
  priceRange: {                 // Range di prezzo coperto
    min: number;
    max: number;
  };
}

export interface LiquidityMap {
  symbol: string;
  timestamp: number;
  currentPrice: number;
  
  // Pools identificati
  bidPools: LiquidityPool[];    // Pools di liquidità sotto il prezzo (supporti)
  askPools: LiquidityPool[];    // Pools di liquidità sopra il prezzo (resistenze)
  
  // Pool dominante (dove il prezzo sarà attirato)
  dominantPool: LiquidityPool | null;
  huntDirection: 'UP' | 'DOWN' | 'NEUTRAL';
  
  // Metriche aggregate
  totalBidLiquidity: number;
  totalAskLiquidity: number;
  liquidityRatio: number;       // bid/ask ratio
  
  // Vacuum zones (zone senza liquidità - prezzo si muove veloce)
  vacuumZones: VacuumZone[];
}

export interface VacuumZone {
  priceStart: number;
  priceEnd: number;
  distancePercent: number;
  side: 'ABOVE' | 'BELOW';
}

export interface LiquidityHunterSignal {
  decision: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  liquidityMap: LiquidityMap;
  targetPrice: number | null;    // Dove ci aspettiamo che vada il prezzo
  stopPrice: number | null;      // Stop loss suggerito
}

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // Clustering
  CLUSTER_DISTANCE_PERCENT: 0.08,    // Ordini entro 0.08% sono nello stesso cluster
  MIN_POOL_SIZE_MULTIPLIER: 2.5,     // Pool deve essere 2.5x la media per essere significativo
  MIN_ORDERS_IN_POOL: 3,             // Minimo 3 ordini per formare un pool
  
  // Analisi
  MAX_DISTANCE_PERCENT: 0.5,         // Guarda solo liquidità entro 0.5% dal prezzo
  VACUUM_THRESHOLD: 0.3,             // Zona è "vacuum" se ha <30% della liquidità media
  
  // Trading
  MIN_LIQUIDITY_RATIO_FOR_TRADE: 1.5,  // Serve almeno 1.5x più liquidità in una direzione
  MIN_MAGNET_SCORE: 60,                // Score minimo per considerare un pool
  MIN_CONFIDENCE: 0.75,                // Confidence minima per tradare
  
  // Target/Stop
  TARGET_DISTANCE_RATIO: 0.7,        // Target al 70% della distanza verso il pool
  STOP_DISTANCE_RATIO: 0.5,          // Stop al 50% nella direzione opposta
};

// ========================================
// LIQUIDITY HUNTER CLASS
// ========================================

class LiquidityHunterStrategy {
  
  /**
   * Analizza l'order book e genera una mappa della liquidità
   */
  async analyzeLiquidity(symbol: string): Promise<LiquidityMap | null> {
    try {
      const orderBook = await hyperliquidService.getOrderBook(symbol, 50); // Più livelli per analisi migliore
      
      if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
        logger.warn(`[LiquidityHunter] Empty order book for ${symbol}`);
        return null;
      }
      
      const bestBid = orderBook.bids[0].price;
      const bestAsk = orderBook.asks[0].price;
      const currentPrice = (bestBid + bestAsk) / 2;
      
      // Identifica i liquidity pools
      const bidPools = this.identifyPools(orderBook.bids, currentPrice, 'BID');
      const askPools = this.identifyPools(orderBook.asks, currentPrice, 'ASK');
      
      // Calcola liquidità totale
      const totalBidLiquidity = bidPools.reduce((sum, p) => sum + p.totalSize, 0);
      const totalAskLiquidity = askPools.reduce((sum, p) => sum + p.totalSize, 0);
      const liquidityRatio = totalAskLiquidity > 0 ? totalBidLiquidity / totalAskLiquidity : 1;
      
      // Trova il pool dominante (quello che attrae di più il prezzo)
      const dominantPool = this.findDominantPool([...bidPools, ...askPools]);
      
      // Determina la direzione di hunting
      let huntDirection: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
      if (dominantPool) {
        huntDirection = dominantPool.side === 'ASK' ? 'UP' : 'DOWN';
      }
      
      // Identifica vacuum zones
      const vacuumZones = this.findVacuumZones(orderBook.bids, orderBook.asks, currentPrice);
      
      const liquidityMap: LiquidityMap = {
        symbol,
        timestamp: Date.now(),
        currentPrice,
        bidPools,
        askPools,
        dominantPool,
        huntDirection,
        totalBidLiquidity,
        totalAskLiquidity,
        liquidityRatio,
        vacuumZones,
      };
      
      logger.info(`🎯 [LiquidityHunter] ${symbol} Analysis:`, {
        currentPrice: currentPrice.toFixed(2),
        bidPools: bidPools.length,
        askPools: askPools.length,
        dominantPool: dominantPool ? `${dominantPool.side} @ $${dominantPool.priceLevel.toFixed(2)} (score: ${dominantPool.magnetScore})` : 'none',
        huntDirection,
        liquidityRatio: liquidityRatio.toFixed(2),
        vacuumZones: vacuumZones.length,
      });
      
      return liquidityMap;
      
    } catch (error) {
      logger.error(`[LiquidityHunter] Error analyzing ${symbol}`, error);
      return null;
    }
  }
  
  /**
   * Identifica cluster di liquidità (pools)
   */
  private identifyPools(
    levels: { price: number; size: number }[],
    currentPrice: number,
    side: 'BID' | 'ASK'
  ): LiquidityPool[] {
    if (levels.length === 0) return [];
    
    // Filtra solo livelli entro la distanza massima
    const relevantLevels = levels.filter(l => {
      const dist = Math.abs(l.price - currentPrice) / currentPrice * 100;
      return dist <= CONFIG.MAX_DISTANCE_PERCENT;
    });
    
    if (relevantLevels.length === 0) return [];
    
    // Calcola size media
    const avgSize = relevantLevels.reduce((sum, l) => sum + l.size, 0) / relevantLevels.length;
    
    // Raggruppa in cluster
    const pools: LiquidityPool[] = [];
    const clusterThreshold = currentPrice * (CONFIG.CLUSTER_DISTANCE_PERCENT / 100);
    
    let currentCluster: { price: number; size: number }[] = [];
    let clusterStart = relevantLevels[0]?.price || 0;
    
    for (const level of relevantLevels) {
      if (currentCluster.length === 0) {
        currentCluster.push(level);
        clusterStart = level.price;
      } else if (Math.abs(level.price - clusterStart) <= clusterThreshold) {
        currentCluster.push(level);
      } else {
        // Chiudi cluster corrente e iniziane uno nuovo
        const pool = this.createPool(currentCluster, currentPrice, side, avgSize);
        if (pool) pools.push(pool);
        
        currentCluster = [level];
        clusterStart = level.price;
      }
    }
    
    // Ultimo cluster
    if (currentCluster.length > 0) {
      const pool = this.createPool(currentCluster, currentPrice, side, avgSize);
      if (pool) pools.push(pool);
    }
    
    // Ordina per magnet score
    return pools.sort((a, b) => b.magnetScore - a.magnetScore);
  }
  
  /**
   * Crea un pool da un cluster di ordini
   */
  private createPool(
    cluster: { price: number; size: number }[],
    currentPrice: number,
    side: 'BID' | 'ASK',
    avgSize: number
  ): LiquidityPool | null {
    if (cluster.length < CONFIG.MIN_ORDERS_IN_POOL) return null;
    
    const totalSize = cluster.reduce((sum, l) => sum + l.size, 0);
    
    // Pool deve essere significativo (> 2.5x media)
    if (totalSize < avgSize * CONFIG.MIN_POOL_SIZE_MULTIPLIER * cluster.length) return null;
    
    const prices = cluster.map(l => l.price);
    const priceLevel = prices.reduce((sum, p) => sum + p, 0) / prices.length; // Prezzo medio
    const distancePercent = Math.abs(priceLevel - currentPrice) / currentPrice * 100;
    
    // Calcola magnet score:
    // - Più liquidità = più attrazione
    // - Più vicino = più attrazione
    // - Più ordini = più affidabile
    const sizeScore = Math.min(totalSize / (avgSize * 5), 1) * 40;  // Max 40 punti
    const distanceScore = Math.max(0, 1 - distancePercent / CONFIG.MAX_DISTANCE_PERCENT) * 35; // Max 35 punti
    const orderCountScore = Math.min(cluster.length / 10, 1) * 25; // Max 25 punti
    
    const magnetScore = Math.round(sizeScore + distanceScore + orderCountScore);
    
    return {
      priceLevel,
      totalSize,
      orderCount: cluster.length,
      distancePercent,
      magnetScore,
      side,
      priceRange: {
        min: Math.min(...prices),
        max: Math.max(...prices),
      },
    };
  }
  
  /**
   * Trova il pool dominante (quello che attrae di più il prezzo)
   */
  private findDominantPool(pools: LiquidityPool[]): LiquidityPool | null {
    if (pools.length === 0) return null;
    
    // Filtra solo pool con score sufficiente
    const significantPools = pools.filter(p => p.magnetScore >= CONFIG.MIN_MAGNET_SCORE);
    
    if (significantPools.length === 0) return null;
    
    // Ritorna quello con score più alto
    return significantPools[0];
  }
  
  /**
   * Trova vacuum zones (zone senza liquidità dove il prezzo si muove veloce)
   */
  private findVacuumZones(
    bids: { price: number; size: number }[],
    asks: { price: number; size: number }[],
    currentPrice: number
  ): VacuumZone[] {
    const zones: VacuumZone[] = [];
    
    // Calcola liquidità media per livello
    const allLevels = [...bids, ...asks];
    const avgLiquidity = allLevels.reduce((sum, l) => sum + l.size, 0) / allLevels.length;
    const vacuumThreshold = avgLiquidity * CONFIG.VACUUM_THRESHOLD;
    
    // Cerca gap nei bid (sotto il prezzo)
    for (let i = 0; i < bids.length - 1; i++) {
      const gap = bids[i].price - bids[i + 1].price;
      const gapPercent = gap / currentPrice * 100;
      
      // Se c'è un gap significativo E bassa liquidità
      if (gapPercent > 0.05 && bids[i + 1].size < vacuumThreshold) {
        zones.push({
          priceStart: bids[i + 1].price,
          priceEnd: bids[i].price,
          distancePercent: Math.abs(bids[i].price - currentPrice) / currentPrice * 100,
          side: 'BELOW',
        });
      }
    }
    
    // Cerca gap negli ask (sopra il prezzo)
    for (let i = 0; i < asks.length - 1; i++) {
      const gap = asks[i + 1].price - asks[i].price;
      const gapPercent = gap / currentPrice * 100;
      
      if (gapPercent > 0.05 && asks[i + 1].size < vacuumThreshold) {
        zones.push({
          priceStart: asks[i].price,
          priceEnd: asks[i + 1].price,
          distancePercent: Math.abs(asks[i].price - currentPrice) / currentPrice * 100,
          side: 'ABOVE',
        });
      }
    }
    
    return zones.sort((a, b) => a.distancePercent - b.distancePercent);
  }
  
  /**
   * Genera segnale di trading basato sulla liquidity map
   */
  async generateSignal(symbol: string): Promise<LiquidityHunterSignal | null> {
    try {
      // Ottieni liquidity map
      const liquidityMap = await this.analyzeLiquidity(symbol);
      if (!liquidityMap) return null;
      
      // Ottieni anche analisi order book standard per conferma
      const orderBookAnalysis = await orderBookAnalyzer.analyzeOrderBook(symbol);
      
      let decision: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let confidence = 0;
      let reasons: string[] = [];
      let targetPrice: number | null = null;
      let stopPrice: number | null = null;
      
      const { dominantPool, huntDirection, liquidityRatio, vacuumZones, currentPrice } = liquidityMap;
      
      // ========================================
      // LOGICA DI TRADING
      // ========================================
      
      // 1. Verifica che ci sia un pool dominante
      if (!dominantPool || dominantPool.magnetScore < CONFIG.MIN_MAGNET_SCORE) {
        reasons.push(`⏸️ Nessun pool dominante (score < ${CONFIG.MIN_MAGNET_SCORE})`);
        return {
          decision: 'HOLD',
          confidence: 0,
          reasoning: reasons.join(' | '),
          liquidityMap,
          targetPrice: null,
          stopPrice: null,
        };
      }
      
      // 2. Calcola confidence base dal magnet score
      confidence = dominantPool.magnetScore / 100;
      
      // 3. Verifica ratio di liquidità
      if (huntDirection === 'UP') {
        // Cerchiamo di comprare per seguire il prezzo verso il pool ASK
        if (liquidityRatio > CONFIG.MIN_LIQUIDITY_RATIO_FOR_TRADE) {
          // Troppa liquidità BID rispetto ad ASK - il prezzo potrebbe non salire
          confidence *= 0.7;
          reasons.push(`⚠️ Ratio liquidità sfavorevole (${liquidityRatio.toFixed(2)})`);
        }
        decision = 'BUY';
        targetPrice = dominantPool.priceLevel * (1 - (1 - CONFIG.TARGET_DISTANCE_RATIO) * dominantPool.distancePercent / 100);
        stopPrice = currentPrice * (1 - CONFIG.STOP_DISTANCE_RATIO * dominantPool.distancePercent / 100);
        reasons.push(`🎯 Pool ASK dominante @ $${dominantPool.priceLevel.toFixed(2)} (score: ${dominantPool.magnetScore})`);
        
      } else if (huntDirection === 'DOWN') {
        // Cerchiamo di vendere per seguire il prezzo verso il pool BID
        if (liquidityRatio < 1 / CONFIG.MIN_LIQUIDITY_RATIO_FOR_TRADE) {
          confidence *= 0.7;
          reasons.push(`⚠️ Ratio liquidità sfavorevole (${liquidityRatio.toFixed(2)})`);
        }
        decision = 'SELL';
        targetPrice = dominantPool.priceLevel * (1 + (1 - CONFIG.TARGET_DISTANCE_RATIO) * dominantPool.distancePercent / 100);
        stopPrice = currentPrice * (1 + CONFIG.STOP_DISTANCE_RATIO * dominantPool.distancePercent / 100);
        reasons.push(`🎯 Pool BID dominante @ $${dominantPool.priceLevel.toFixed(2)} (score: ${dominantPool.magnetScore})`);
      }
      
      // 4. Bonus/Malus da vacuum zones
      const relevantVacuum = vacuumZones.find(v => 
        (huntDirection === 'UP' && v.side === 'ABOVE') ||
        (huntDirection === 'DOWN' && v.side === 'BELOW')
      );
      
      if (relevantVacuum) {
        confidence += 0.10; // Vacuum nella direzione = prezzo si muove veloce
        reasons.push(`🚀 Vacuum zone rilevata - movimento veloce atteso`);
      }
      
      // 5. Conferma da order book analysis (se disponibile)
      if (orderBookAnalysis) {
        const obConfirms = 
          (decision === 'BUY' && orderBookAnalysis.imbalanceRatio > 0.1) ||
          (decision === 'SELL' && orderBookAnalysis.imbalanceRatio < -0.1);
        
        if (obConfirms) {
          confidence += 0.08;
          reasons.push(`✅ Order book conferma direzione`);
        } else if (
          (decision === 'BUY' && orderBookAnalysis.imbalanceRatio < -0.2) ||
          (decision === 'SELL' && orderBookAnalysis.imbalanceRatio > 0.2)
        ) {
          confidence -= 0.15;
          reasons.push(`⚠️ Order book in disaccordo`);
        }
        
        // Bonus se market state è favorevole
        if (
          (decision === 'BUY' && orderBookAnalysis.marketState === 'IMBALANCED_UP') ||
          (decision === 'SELL' && orderBookAnalysis.marketState === 'IMBALANCED_DOWN')
        ) {
          confidence += 0.10;
          reasons.push(`📊 Market state conferma: ${orderBookAnalysis.marketState}`);
        }
      }
      
      // 6. Cap confidence e verifica soglia minima
      confidence = Math.min(0.95, Math.max(0, confidence));
      
      if (confidence < CONFIG.MIN_CONFIDENCE) {
        reasons.push(`❌ Confidence insufficiente (${(confidence * 100).toFixed(0)}% < ${(CONFIG.MIN_CONFIDENCE * 100).toFixed(0)}%)`);
        decision = 'HOLD';
        confidence = 0;
      }
      
      // Log finale
      if (decision !== 'HOLD' && dominantPool) {
        logger.info(`🎯 [LiquidityHunter] SIGNAL: ${decision} ${symbol} | conf: ${(confidence * 100).toFixed(0)}% | target: ${targetPrice ? targetPrice.toFixed(2) : 'N/A'} | stop: ${stopPrice ? stopPrice.toFixed(2) : 'N/A'} | pool: ${dominantPool.side} @ $${dominantPool.priceLevel.toFixed(2)}`);
      }
      
      return {
        decision,
        confidence,
        reasoning: reasons.join(' | '),
        liquidityMap,
        targetPrice,
        stopPrice,
      };
      
    } catch (error) {
      logger.error(`[LiquidityHunter] Error generating signal for ${symbol}`, error);
      return null;
    }
  }
  
  /**
   * Combina segnale liquidity hunter con order book strategy
   * Usa liquidity hunter come CONFERMA aggiuntiva
   */
  async getConfirmation(
    symbol: string,
    proposedDirection: 'BUY' | 'SELL'
  ): Promise<{ confirmed: boolean; confidence: number; reasoning: string }> {
    try {
      const liquidityMap = await this.analyzeLiquidity(symbol);
      
      if (!liquidityMap) {
        return { confirmed: false, confidence: 0, reasoning: 'No liquidity data' };
      }
      
      const { dominantPool, huntDirection, vacuumZones } = liquidityMap;
      
      // Conferma se la direzione proposta è allineata con la liquidity hunt
      const directionMatch = 
        (proposedDirection === 'BUY' && huntDirection === 'UP') ||
        (proposedDirection === 'SELL' && huntDirection === 'DOWN');
      
      if (!directionMatch) {
        return {
          confirmed: false,
          confidence: 0.3,
          reasoning: `⛔ Liquidity hunt in direzione opposta (${huntDirection})`,
        };
      }
      
      let confidence = dominantPool ? dominantPool.magnetScore / 100 : 0.5;
      const reasons: string[] = [];
      
      // Bonus da vacuum zone
      const hasVacuum = vacuumZones.some(v =>
        (proposedDirection === 'BUY' && v.side === 'ABOVE') ||
        (proposedDirection === 'SELL' && v.side === 'BELOW')
      );
      
      if (hasVacuum) {
        confidence += 0.10;
        reasons.push('Vacuum zone conferma');
      }
      
      if (dominantPool) {
        reasons.push(`Pool ${dominantPool.side} @ $${dominantPool.priceLevel.toFixed(2)} (score: ${dominantPool.magnetScore})`);
      }
      
      return {
        confirmed: true,
        confidence: Math.min(0.95, confidence),
        reasoning: `✅ Liquidity confirms ${proposedDirection}: ${reasons.join(', ')}`,
      };
      
    } catch (error) {
      return { confirmed: false, confidence: 0, reasoning: 'Error analyzing liquidity' };
    }
  }
}

export const liquidityHunterStrategy = new LiquidityHunterStrategy();
export default liquidityHunterStrategy;
