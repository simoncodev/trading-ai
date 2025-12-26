import { EventEmitter } from 'events';
import { logger } from './logger';
import { multiSymbolTracker, SymbolSnapshot } from '../services/multiSymbolLiquidityTracker';
import { hyperliquidService } from '../services/hyperliquidService';
import dbService from '../database/dbService';
import { config } from '../utils/config';

/**
 * EVENT-DRIVEN TRADE LOOP
 * 
 * Reagisce in tempo reale ad ogni tick di mercato.
 * Apre posizioni su segnali forti, chiude su TP o segnale opposto.
 */

// ========================================
// TYPES
// ========================================

export interface Position {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  leverage: number;
  openedAt: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  lastSignal: 'BUY' | 'SELL' | 'WAIT';
  unrealizedPnl: number;
  maxPnlPercent: number;      // Track highest P&L for trailing stop
  trailingActivated: boolean; // Whether trailing stop is active
}

export interface TradeSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  price: number;
  timestamp: number;
  reasoning: string;
  details?: {
    askSpoofCount: number;
    bidSpoofCount: number;
    askSpoofVolume: number;
    bidSpoofVolume: number;
    spoofRatio: number;
    highConfidenceAlerts: number;
    currentPrice: number;
  };
}

export interface TradeExecution {
  type: 'OPEN' | 'CLOSE';
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  reason: string;
  pnl?: number;
  timestamp: number;
}

// ========================================
// CONFIGURATION
// ========================================

const TRADE_CONFIG = {
  // Soglie per segnale "forte" - PIÙ SELETTIVO
  MIN_CONFIDENCE_TO_OPEN: 80,      // 80% confidence per aprire
  MIN_CONFIDENCE_TO_CLOSE: 75,     // 75% confidence per chiudere con segnale opposto
  
  // Take Profit / Stop Loss - CON TRAILING
  TAKE_PROFIT_PERCENT: 0.25,       // 0.25% TP (con 40x = 10% P&L) - può essere superato con trailing
  STOP_LOSS_PERCENT: 0.15,         // 0.15% SL (con 40x = 6% P&L)
  
  // TRAILING STOP CONFIG
  TRAILING_ACTIVATION_PERCENT: 0.08, // Attiva trailing dopo 0.08% movimento (3.2% P&L con 40x)
  TRAILING_DISTANCE_PERCENT: 0.04,   // Chiudi se scende di 0.04% dal max (1.6% P&L con 40x)
  
  // Position sizing
  POSITION_SIZE_PERCENT: 0.40,     // 40% del capitale per trade
  MAX_POSITIONS: 1,                // Max 1 posizione
  LEVERAGE: parseInt(process.env.MAX_LEVERAGE || '40'), // Leva da .env
  
  // ANTI FLIP-FLOP SETTINGS
  TRADE_COOLDOWN_MS: 120000,       // 120 secondi (2 min) cooldown dopo ogni trade
  SIGNAL_DEBOUNCE_MS: 15000,       // Segnale deve persistere 15 secondi
  MIN_HOLD_TIME_MS: 60000,         // Mantieni posizione minimo 1 minuto (ridotto)
  SIGNAL_STABILITY_WINDOW: 60000,  // Finestra di 60s per calcolare stabilità
  MAX_SIGNAL_CHANGES: 2,           // Max 2 cambi segnale in 60s per considerarlo stabile
  NO_FLIP_IN_LOSS: true,           // Non flippare se in perdita (aspetta SL)
};

// ========================================
// SIGNAL HISTORY TRACKER (Anti Flip-Flop)
// ========================================

interface SignalHistoryEntry {
  action: 'BUY' | 'SELL' | 'WAIT';
  timestamp: number;
}

const signalHistory: Map<string, SignalHistoryEntry[]> = new Map();

function recordSignal(symbol: string, action: 'BUY' | 'SELL' | 'WAIT'): void {
  if (!signalHistory.has(symbol)) {
    signalHistory.set(symbol, []);
  }
  const history = signalHistory.get(symbol)!;
  const now = Date.now();
  
  // Solo registra se diverso dall'ultimo
  if (history.length === 0 || history[history.length - 1].action !== action) {
    history.push({ action, timestamp: now });
  }
  
  // Limita la dimensione massima a 100 entries per simbolo per evitare accumulo eccessivo
  if (history.length > 100) {
    history.shift();
  }
  
  // Pulisci entries vecchie (oltre 2 minuti)
  const cutoff = now - 120000;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }
}

function countSignalChanges(symbol: string, windowMs: number): number {
  const history = signalHistory.get(symbol) || [];
  const cutoff = Date.now() - windowMs;
  return history.filter(h => h.timestamp >= cutoff).length;
}

function isSignalStable(symbol: string): boolean {
  const changes = countSignalChanges(symbol, TRADE_CONFIG.SIGNAL_STABILITY_WINDOW);
  return changes <= TRADE_CONFIG.MAX_SIGNAL_CHANGES;
}

// ========================================
// EVENT-DRIVEN TRADE LOOP CLASS
// ========================================

class EventDrivenTradeLoop extends EventEmitter {
  private isRunning = false;
  private positions: Map<string, Position> = new Map();
  private lastTradeTime: Map<string, number> = new Map();
  private signalBuffer: Map<string, { signal: TradeSignal; firstSeen: number }> = new Map();
  private currentBalance: number = 0;
  
  constructor() {
    super();
  }

  private syncInterval: NodeJS.Timeout | null = null;
  private memoryMonitorInterval: NodeJS.Timeout | null = null;

  /**
   * Start the event-driven trade loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[EventLoop] Already running');
      return;
    }

    logger.info('🚀 [EventLoop] Starting Event-Driven Trade Loop');
    this.isRunning = true;

    // Load current balance from database
    this.currentBalance = await dbService.getCurrentBalance();
    logger.info(`[EventLoop] Current balance: $${this.currentBalance.toFixed(2)}`);

    // Load existing positions from database
    await this.loadPositionsFromDb();

    // Start periodic sync with exchange (every 30s)
    if (!config.system.dryRun) {
      this.syncInterval = setInterval(() => this.syncWithExchange(), 30000);
      logger.info('[EventLoop] Started periodic exchange sync (30s)');
    }

    // Start periodic memory monitoring (every 10 minutes)
    this.memoryMonitorInterval = setInterval(() => this.logMemoryUsage(), 10 * 60 * 1000);
    logger.info('[EventLoop] Started periodic memory monitoring (10min)');

    // Subscribe to multiSymbolTracker events
    multiSymbolTracker.on('snapshot', this.onSnapshot.bind(this));
    
    // Start multiSymbolTracker if not already running
    const status = multiSymbolTracker.getStatus();
    if (status.running.length === 0) {
      multiSymbolTracker.startAll();
    }

    logger.info('[EventLoop] Event-driven trade loop started');
  }

  /**
   * Reload state from database (balance and positions)
   * Called when database is reset or manually updated
   */
  async reloadState(): Promise<void> {
    logger.info('[EventLoop] Reloading state from database...');
    this.currentBalance = await dbService.getCurrentBalance();
    this.positions.clear();
    await this.loadPositionsFromDb();
    logger.info(`[EventLoop] State reloaded. Balance: $${this.currentBalance.toFixed(2)}, Positions: ${this.positions.size}`);
    
    // Emit updated state immediately
    this.emit('positions', this.getPositionsSummary());
  }

  /**
   * Stop the trade loop
   */
  stop(): void {
    logger.info('[EventLoop] Stopping...');
    this.isRunning = false;
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
    }
    multiSymbolTracker.removeListener('snapshot', this.onSnapshot.bind(this));
  }

  /**
   * Log current memory usage for monitoring
   */
  private logMemoryUsage(): void {
    const memUsage = process.memoryUsage();
    logger.info('[Memory] Usage - RSS: ' + (memUsage.rss / 1024 / 1024).toFixed(2) + 'MB, ' +
               'Heap Used: ' + (memUsage.heapUsed / 1024 / 1024).toFixed(2) + 'MB, ' +
               'Heap Total: ' + (memUsage.heapTotal / 1024 / 1024).toFixed(2) + 'MB, ' +
               'External: ' + (memUsage.external / 1024 / 1024).toFixed(2) + 'MB');
  }

  /**
   * Handle snapshot event from multiSymbolTracker
   * This is called on EVERY TICK
   */
  private async onSnapshot(data: { symbol: string; snapshot: SymbolSnapshot }): Promise<void> {
    if (!this.isRunning) return;

    const { symbol, snapshot } = data;

    try {
      // 1. Get WALL PRESSURE signal (new logic - trades WITH the wall, not after)
      const signal = multiSymbolTracker.getWallPressureSignal(symbol);
      const currentPrice = snapshot.currentPrice;

      // 2. Record signal for stability tracking (anti flip-flop)
      recordSignal(symbol, signal.action);

      // 3. Create trade signal with wall pressure details
      const tradeSignal: TradeSignal = {
        symbol,
        action: signal.action,
        confidence: signal.confidence,
        price: currentPrice,
        timestamp: Date.now(),
        reasoning: signal.reasoning,
        details: signal.details, // Include wall pressure details for dashboard
      };

      // 4. Emit signal update for dashboard
      this.emit('signal', tradeSignal);

      // 4. Check existing position for this symbol
      const position = this.positions.get(symbol);

      if (position) {
        // We have an open position - check for exit conditions
        await this.checkExitConditions(position, tradeSignal, currentPrice);
      } else {
        // No position - check for entry conditions
        await this.checkEntryConditions(tradeSignal);
      }

      // 5. Update P&L for all positions
      this.updateAllPositionsPnl();

    } catch (error) {
      logger.error(`[EventLoop] Error processing snapshot for ${symbol}:`, error);
    }
  }

  /**
   * Check entry conditions
   */
  private async checkEntryConditions(signal: TradeSignal): Promise<void> {
    // Skip if not a strong signal
    if (signal.action === 'WAIT' || signal.confidence < TRADE_CONFIG.MIN_CONFIDENCE_TO_OPEN) {
      // Clear signal buffer if signal weakened
      this.signalBuffer.delete(signal.symbol);
      return;
    }

    // Check cooldown
    const lastTrade = this.lastTradeTime.get(signal.symbol) || 0;
    if (Date.now() - lastTrade < TRADE_CONFIG.TRADE_COOLDOWN_MS) {
      logger.debug(`[EventLoop] Entry blocked by cooldown for ${signal.symbol}`);
      return;
    }

    // Check max positions
    if (this.positions.size >= TRADE_CONFIG.MAX_POSITIONS) {
      logger.debug(`[EventLoop] Max positions reached (${TRADE_CONFIG.MAX_POSITIONS})`);
      return;
    }

    // Check signal stability (anti flip-flop)
    if (!isSignalStable(signal.symbol)) {
      const changes = countSignalChanges(signal.symbol, TRADE_CONFIG.SIGNAL_STABILITY_WINDOW);
      logger.debug(`[EventLoop] Signal unstable for ${signal.symbol}: ${changes} changes in window`);
      this.signalBuffer.delete(signal.symbol);
      return;
    }

    // Signal debounce - must persist for SIGNAL_DEBOUNCE_MS
    const buffered = this.signalBuffer.get(signal.symbol);
    if (!buffered || buffered.signal.action !== signal.action) {
      // New signal or direction changed - start debounce
      this.signalBuffer.set(signal.symbol, { signal, firstSeen: Date.now() });
      logger.debug(`[EventLoop] Starting entry debounce for ${signal.symbol}: ${signal.action}`);
      return;
    }

    // Check if signal has persisted long enough
    const signalAge = Date.now() - buffered.firstSeen;
    if (signalAge < TRADE_CONFIG.SIGNAL_DEBOUNCE_MS) {
      return;
    }

    // Signal is strong and stable - OPEN POSITION
    logger.info(`✅ [EventLoop] All criteria met for ${signal.symbol}: ${signal.action} @ ${signal.confidence}%`);
    await this.openPosition(signal);
    this.signalBuffer.delete(signal.symbol);
  }

  /**
   * Check exit conditions for an open position
   */
  private async checkExitConditions(position: Position, signal: TradeSignal, currentPrice: number): Promise<void> {
    // Calculate current P&L percentage
    const priceDiff = position.side === 'BUY' 
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;
    
    const pnlPercent = priceDiff * 100;
    const leveragedPnlPercent = pnlPercent * position.leverage;
    const holdTime = Date.now() - position.openedAt;

    // UPDATE MAX P&L for trailing stop
    if (pnlPercent > position.maxPnlPercent) {
      position.maxPnlPercent = pnlPercent;
    }

    // 1. Check Stop Loss (safety net) - FIRST PRIORITY
    if (pnlPercent <= -TRADE_CONFIG.STOP_LOSS_PERCENT) {
      await this.closePosition(position, currentPrice, `🛑 SL raggiunto: ${leveragedPnlPercent.toFixed(2)}%`);
      return;
    }

    // 2. TRAILING STOP LOGIC
    if (pnlPercent >= TRADE_CONFIG.TRAILING_ACTIVATION_PERCENT) {
      // Activate trailing stop
      if (!position.trailingActivated) {
        position.trailingActivated = true;
        logger.info(`📈 [Trailing] Activated for ${position.symbol} @ ${(pnlPercent * position.leverage).toFixed(2)}% P&L`);
      }
    }

    if (position.trailingActivated) {
      const dropFromMax = position.maxPnlPercent - pnlPercent;
      
      // If price dropped more than trailing distance from max, close
      if (dropFromMax >= TRADE_CONFIG.TRAILING_DISTANCE_PERCENT && pnlPercent > 0) {
        await this.closePosition(position, currentPrice, 
          `📉 Trailing Stop: Max ${(position.maxPnlPercent * position.leverage).toFixed(2)}% → ${leveragedPnlPercent.toFixed(2)}%`);
        return;
      }
    }

    // 3. Check Take Profit (hard cap)
    if (pnlPercent >= TRADE_CONFIG.TAKE_PROFIT_PERCENT) {
      await this.closePosition(position, currentPrice, `🎯 TP raggiunto: ${leveragedPnlPercent.toFixed(2)}%`);
      return;
    }

    // 4. Check wall pressure equilibrium - exit if in profit and wall advantage is gone
    if (signal.details && holdTime > 60000) {
      const pressureRatio = signal.details.spoofRatio || 1;
      const EQUILIBRIUM_THRESHOLD = 1.3;
      const MIN_PROFIT_TO_EXIT = 0.05;  // Lowered since we have trailing
      
      if (pressureRatio < EQUILIBRIUM_THRESHOLD && pnlPercent >= MIN_PROFIT_TO_EXIT) {
        await this.closePosition(position, currentPrice, 
          `⚖️ Wall equilibrato - Profit lock: ${leveragedPnlPercent.toFixed(2)}%`);
        return;
      }
      
      // If wall INVERTED strongly - exit
      const bidVolume = signal.details.bidSpoofVolume || 0;
      const askVolume = signal.details.askSpoofVolume || 0;
      const dominantSide = bidVolume > askVolume ? 'BUY' : 'SELL';
      
      if (pressureRatio >= 2.5 && dominantSide !== position.side) {
        await this.closePosition(position, currentPrice, 
          `⚠️ Wall invertito! ${dominantSide} pressure ${pressureRatio.toFixed(1)}x - Exit: ${leveragedPnlPercent.toFixed(2)}%`);
        return;
      }
    }

    // 5. Check minimum hold time (anti flip-flop)
    if (holdTime < TRADE_CONFIG.MIN_HOLD_TIME_MS) {
      return;
    }

    // 5. Check for position FLIP (opposite signal)
    const oppositeAction = position.side === 'BUY' ? 'SELL' : 'BUY';
    if (signal.action === oppositeAction) {
      
      // 5a. Check if in loss - don't flip, wait for SL or recovery
      if (TRADE_CONFIG.NO_FLIP_IN_LOSS && pnlPercent < 0) {
        logger.debug(`[EventLoop] No flip while in loss: ${pnlPercent.toFixed(3)}%`);
        this.signalBuffer.delete(signal.symbol);
        return;
      }

      // 5b. Check signal stability (anti flip-flop)
      if (!isSignalStable(signal.symbol)) {
        const changes = countSignalChanges(signal.symbol, TRADE_CONFIG.SIGNAL_STABILITY_WINDOW);
        logger.debug(`[EventLoop] Flip blocked - unstable signal: ${changes} changes`);
        this.signalBuffer.delete(signal.symbol);
        return;
      }

      // 5c. Must meet FULL ENTRY criteria
      if (signal.confidence >= TRADE_CONFIG.MIN_CONFIDENCE_TO_OPEN) {
        // Check cooldown
        const lastTrade = this.lastTradeTime.get(signal.symbol) || 0;
        if (Date.now() - lastTrade < TRADE_CONFIG.TRADE_COOLDOWN_MS) {
          logger.debug(`[EventLoop] Flip blocked by cooldown for ${signal.symbol}`);
          return;
        }

        // Check debounce - signal must persist
        const buffered = this.signalBuffer.get(signal.symbol);
        if (!buffered || buffered.signal.action !== signal.action) {
          this.signalBuffer.set(signal.symbol, { signal, firstSeen: Date.now() });
          logger.debug(`[EventLoop] Starting flip debounce for ${signal.symbol}: ${signal.action}`);
          return;
        }

        const signalAge = Date.now() - buffered.firstSeen;
        if (signalAge < TRADE_CONFIG.SIGNAL_DEBOUNCE_MS) {
          return;
        }

        // ALL criteria met - close and flip
        logger.info(`🔄 [EventLoop] FLIP ${position.side} → ${oppositeAction} on ${signal.symbol} (P&L: ${pnlPercent.toFixed(3)}%)`);
        await this.closePosition(position, currentPrice, `Flip: ${signal.action} (${signal.confidence}%)`);
        this.signalBuffer.delete(signal.symbol);
        
        // Open new position in opposite direction
        await this.openPosition(signal);
        return;
      } else {
        this.signalBuffer.delete(signal.symbol);
      }
    }

    // Update position's last signal
    position.lastSignal = signal.action;
  }

  /**
   * Open a new position
   */
  private async openPosition(signal: TradeSignal): Promise<void> {
    const { symbol, action, price, confidence, reasoning } = signal;
    
    // Calculate position size
    const positionValue = this.currentBalance * TRADE_CONFIG.POSITION_SIZE_PERCENT;
    const quantity = positionValue / price;

    // Calculate TP/SL prices
    const tpMultiplier = action === 'BUY' 
      ? 1 + (TRADE_CONFIG.TAKE_PROFIT_PERCENT / 100)
      : 1 - (TRADE_CONFIG.TAKE_PROFIT_PERCENT / 100);
    const slMultiplier = action === 'BUY'
      ? 1 - (TRADE_CONFIG.STOP_LOSS_PERCENT / 100)
      : 1 + (TRADE_CONFIG.STOP_LOSS_PERCENT / 100);

    const position: Position = {
      id: `pos_${Date.now()}_${symbol}`,
      symbol,
      side: action as 'BUY' | 'SELL',
      entryPrice: price,
      quantity,
      leverage: TRADE_CONFIG.LEVERAGE,
      openedAt: Date.now(),
      takeProfitPrice: price * tpMultiplier,
      stopLossPrice: price * slMultiplier,
      lastSignal: action as 'BUY' | 'SELL',
      unrealizedPnl: 0,
      maxPnlPercent: 0,           // Initialize for trailing stop
      trailingActivated: false,   // Trailing not yet active
    };

    // Execute on exchange if not DRY_RUN
    if (!config.system.dryRun) {
      try {
        // Set leverage first
        await hyperliquidService.setLeverage(symbol, TRADE_CONFIG.LEVERAGE);

        const side = action === 'BUY' ? 'buy' : 'sell';
        const orderResult = await hyperliquidService.placeOrder(symbol, side, quantity, signal.price, true);
        logger.info(`[EventLoop] Order placed on exchange: ${side} ${quantity} ${symbol}`, { ...orderResult });
        
        // Update position with actual execution details
        if (orderResult.price) position.entryPrice = orderResult.price;
        if (orderResult.quantity) position.quantity = orderResult.quantity;
        
        // Recalculate TP/SL based on actual entry price
        position.takeProfitPrice = position.entryPrice * tpMultiplier;
        position.stopLossPrice = position.entryPrice * slMultiplier;
        
      } catch (error) {
        logger.error('[EventLoop] Failed to place order on exchange. Aborting trade.', error);
        return; // ABORT: Do not save to DB, do not update memory
      }
    }

    // Store position
    this.positions.set(symbol, position);
    this.lastTradeTime.set(symbol, Date.now());

    // Log and emit
    logger.info(`🟢 [EventLoop] OPEN ${action} ${symbol}`, {
      price: position.entryPrice,
      quantity: position.quantity,
      leverage: TRADE_CONFIG.LEVERAGE,
      confidence,
      tp: position.takeProfitPrice,
      sl: position.stopLossPrice,
    });

    const execution: TradeExecution = {
      type: 'OPEN',
      symbol,
      side: action as 'BUY' | 'SELL',
      price: position.entryPrice,
      quantity: position.quantity,
      reason: reasoning,
      timestamp: Date.now(),
    };
    this.emit('trade', execution);

    // Save to database
    try {
      await this.savePositionToDb(position);
    } catch (error) {
      logger.error('[EventLoop] Failed to save position to DB:', error);
    }
  }

  /**
   * Close an existing position
   */
  private async closePosition(position: Position, currentPrice: number, reason: string): Promise<void> {
    const { symbol, side, entryPrice, quantity, leverage } = position;

    // 1. Execute on exchange if not DRY_RUN (CRITICAL: Do this FIRST)
    if (!config.system.dryRun) {
      try {
        // Use closePosition helper which uses reduceOnly market order
        await hyperliquidService.closePosition(
          symbol, 
          quantity, 
          side === 'BUY' ? 'long' : 'short'
        );
        logger.info(`[EventLoop] Close order placed on exchange: ${symbol}`);
      } catch (error) {
        logger.error('[EventLoop] Failed to place close order on exchange. ABORTING INTERNAL CLOSE.', error);
        // CRITICAL: If exchange close fails, we MUST keep the position in memory/DB
        // so we can try again later.
        return; 
      }
    }

    // Calculate P&L
    const priceDiff = side === 'BUY' 
      ? currentPrice - entryPrice 
      : entryPrice - currentPrice;
    const grossPnl = priceDiff * quantity * leverage;
    
    // Subtract fees (0.035% entry + 0.035% exit = 0.07% total)
    const feeRate = 0.0007;
    const fees = (entryPrice * quantity + currentPrice * quantity) * feeRate;
    const netPnl = grossPnl - fees;

    // Remove position
    this.positions.delete(symbol);
    this.lastTradeTime.set(symbol, Date.now());

    // Calculate fees
    const entryFee = quantity * entryPrice * 0.00035;
    const exitFee = quantity * currentPrice * 0.00035;
    const totalFees = entryFee + exitFee;

    // Update balance (net of fees)
    this.currentBalance += (netPnl - totalFees);

    // Log and emit
    const pnlSign = netPnl >= 0 ? '🟢' : '🔴';
    logger.info(`${pnlSign} [EventLoop] CLOSE ${side} ${symbol}`, {
      entryPrice: entryPrice,
      exitPrice: currentPrice,
      pnl: netPnl,
      fees: totalFees,
      netPnl: netPnl - totalFees,
      reason,
    });

    const execution: TradeExecution = {
      type: 'CLOSE',
      symbol,
      side,
      price: currentPrice,
      quantity,
      reason,
      pnl: netPnl - totalFees,
      timestamp: Date.now(),
    };
    this.emit('trade', execution);

    // Emit specific event for frontend ghost position prevention
    const webServer = (global as any).webServer;
    if (webServer && webServer.io) {
      webServer.io.emit('trade:closed', {
        tradeId: position.id,
        symbol,
        pnl: netPnl - totalFees,
        reason
      });
    }

    // Update database
    try {
      await this.closePositionInDb(position.id, currentPrice, netPnl);
      await dbService.updateBalanceOnTradeClose(netPnl, totalFees);
    } catch (error) {
      logger.error('[EventLoop] Failed to update DB on close:', error);
    }
  }

  /**
   * Update P&L for all open positions
   */
  private updateAllPositionsPnl(): void {
    for (const [symbol, position] of this.positions.entries()) {
      const snapshot = multiSymbolTracker.getSnapshot(symbol);
      if (snapshot) {
        const currentPrice = snapshot.currentPrice;
        const priceDiff = position.side === 'BUY'
          ? currentPrice - position.entryPrice
          : position.entryPrice - currentPrice;
        position.unrealizedPnl = priceDiff * position.quantity * position.leverage;
      }
    }

    // Emit positions update
    this.emit('positions', this.getPositionsSummary());
  }

  /**
   * Get positions summary for dashboard
   */
  getPositionsSummary(): {
    positions: Position[];
    totalUnrealizedPnl: number;
    balance: number;
    equity: number;
  } {
    const positions = Array.from(this.positions.values());
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return {
      positions,
      totalUnrealizedPnl,
      balance: this.currentBalance,
      equity: this.currentBalance + totalUnrealizedPnl,
    };
  }

  /**
   * Remove a position from the in-memory cache (called by PositionManager when closing)
   */
  removePositionFromCache(symbol: string): void {
    if (this.positions.has(symbol)) {
      this.positions.delete(symbol);
      logger.info(`[EventLoop] Position removed from cache: ${symbol}`);
      // Emit updated positions
      this.emit('positions', this.getPositionsSummary());
    }
  }

  /**
   * Get current signals for all symbols
   */
  getCurrentSignals(): Record<string, TradeSignal> {
    const signals: Record<string, TradeSignal> = {};
    for (const symbol of config.trading.symbols) {
      const snapshot = multiSymbolTracker.getSnapshot(symbol);
      const antiSpoofSignal = multiSymbolTracker.getAntiSpoofingSignal(symbol);
      signals[symbol] = {
        symbol,
        action: antiSpoofSignal.action,
        confidence: antiSpoofSignal.confidence,
        price: snapshot?.currentPrice || 0,
        timestamp: Date.now(),
        reasoning: antiSpoofSignal.reasoning,
      };
    }
    return signals;
  }

  // ========================================
  // DATABASE HELPERS
  // ========================================

  /**
   * Sync state with Hyperliquid exchange
   */
  private async syncWithExchange(): Promise<void> {
    if (config.system.dryRun) return;

    logger.info('[EventLoop] LIVE MODE: Syncing positions from Hyperliquid SDK...');
    try {
      const activeTrades = await dbService.getActiveTrades();
      const dbMap = new Map<string, any>();
      for (const trade of activeTrades) {
        dbMap.set(trade.symbol, trade);
      }

      // Add 30s timeout to prevent hanging
      const account = await Promise.race([
        hyperliquidService.getAccount(),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Timeout syncing positions from Hyperliquid')), 30000))
      ]);
      
      // Update Balance from Exchange
      if (typeof account.balance === 'number') {
         this.currentBalance = account.balance;
         logger.info(`[EventLoop] Balance synced from exchange: ${this.currentBalance} USDC`);
         // Sync to DB so UI sees it
         await dbService.syncBalance(this.currentBalance);
      } else {
         logger.warn(`[EventLoop] Balance sync failed: account.balance is ${typeof account.balance}`);
      }
      
      // Clear current positions to rebuild from exchange truth
      this.positions.clear();

      for (const pos of account.positions) {
         // pos.symbol is already denormalized (e.g., "BTC-USDC") by hyperliquidService
         logger.info(`[EventLoop] Processing exchange position: ${pos.symbol} ${pos.side} ${pos.size}`);
         const internalSymbol = pos.symbol; 
         
         // Check if we have DB data for this
         const dbTrade = dbMap.get(internalSymbol);
         
         // Construct Position object
         const position: Position = {
            id: dbTrade?.trade_id || `LIVE_${pos.symbol}_${Date.now()}`,
            symbol: internalSymbol,
            side: pos.side === 'long' ? 'BUY' : 'SELL',
            entryPrice: pos.entryPrice,
            quantity: pos.size,
            leverage: pos.leverage || TRADE_CONFIG.LEVERAGE,
            openedAt: dbTrade ? new Date(dbTrade.executed_at).getTime() : Date.now(),
            takeProfitPrice: dbTrade ? (parseFloat(dbTrade.take_profit) || 0) : 0,
            stopLossPrice: dbTrade ? (parseFloat(dbTrade.stop_loss) || 0) : 0,
            lastSignal: 'WAIT',
            unrealizedPnl: pos.unrealizedPnL,
            maxPnlPercent: 0, // Reset trailing
            trailingActivated: false
         };
         
         this.positions.set(internalSymbol, position);
         logger.info(`[EventLoop] Loaded LIVE position: ${internalSymbol} ${position.side} ${position.quantity}`);
      }
      
      // Check for trades in DB that are NOT on exchange -> Close them in DB
      for (const trade of activeTrades) {
         // trade.symbol is "BTC-USDC"
         const onExchange = account.positions.find((p: any) => p.symbol === trade.symbol);
         if (!onExchange) {
            logger.warn(`[EventLoop] Trade ${trade.symbol} found in DB but NOT on exchange. Closing in DB.`);
            // We don't know exit price or PnL, so we assume break-even or last known price?
            // Ideally we should fetch last price.
            await this.closePositionInDb(trade.trade_id, parseFloat(trade.entry_price), 0);
         }
      }

      // Emit updated positions
      this.emit('positions', this.getPositionsSummary());

    } catch (err) {
      logger.error('[EventLoop] Failed to fetch account from Hyperliquid', err);
    }
  }

  private async loadPositionsFromDb(): Promise<void> {
    try {
      const activeTrades = await dbService.getActiveTrades();
      
      // LIVE MODE: Sync with Exchange
      if (!config.system.dryRun) {
        await this.syncWithExchange();
      } else {
        // DRY RUN: Load purely from DB
        for (const trade of activeTrades) {
          const position: Position = {
            id: trade.trade_id,
            symbol: trade.symbol,
            side: trade.side.toUpperCase() as 'BUY' | 'SELL',
            entryPrice: parseFloat(trade.entry_price),
            quantity: parseFloat(trade.quantity),
            leverage: parseFloat(trade.leverage) || TRADE_CONFIG.LEVERAGE,
            openedAt: new Date(trade.executed_at).getTime(),
            takeProfitPrice: parseFloat(trade.take_profit) || 0,
            stopLossPrice: parseFloat(trade.stop_loss) || 0,
            lastSignal: 'WAIT',
            unrealizedPnl: 0,
            maxPnlPercent: 0,
            trailingActivated: false,
          };
          this.positions.set(position.symbol, position);
        }
      }
      
      logger.info(`[EventLoop] Loaded ${this.positions.size} positions`);
    } catch (error) {
      logger.error('[EventLoop] Failed to load positions from DB:', error);
    }
  }


  private async savePositionToDb(position: Position): Promise<void> {
    // Use saveTrade with proper parameters
    const orderResponse = {
      orderId: position.id,
      symbol: position.symbol,
      side: position.side.toLowerCase() as 'buy' | 'sell',
      type: 'limit' as const,
      quantity: position.quantity,
      price: position.entryPrice,
      status: 'filled' as const,
      filledQuantity: position.quantity,
      timestamp: position.openedAt,
      fee: position.entryPrice * position.quantity * 0.00035,
    };
    
    const decision = {
      symbol: position.symbol,
      decision: position.side as 'BUY' | 'SELL',
      confidence: 0.8,
      reasoning: 'Event-driven anti-spoofing signal',
      currentPrice: position.entryPrice,
      executed: true,
      timestamp: position.openedAt,
      indicators: {
        rsi: 50,
        macd: { macd: 0, signal: 0, histogram: 0 },
        ema12: position.entryPrice,
        ema26: position.entryPrice,
        sma20: position.entryPrice,
        atr: 0,
        volumeAverage: 0,
        bollingerBands: { upper: position.takeProfitPrice, middle: position.entryPrice, lower: position.stopLossPrice },
      },
    };
    
    await dbService.saveTrade(orderResponse, decision, position.leverage);
  }

  private async closePositionInDb(tradeId: string, exitPrice: number, pnl: number): Promise<void> {
    await dbService.closeTrade(tradeId, exitPrice, pnl);
  }
}

// Export singleton
export const eventDrivenTradeLoop = new EventDrivenTradeLoop();
export default eventDrivenTradeLoop;
