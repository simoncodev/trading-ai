import { EventEmitter } from 'events';
import { logger } from './logger';
import { multiSymbolTracker, SymbolSnapshot } from '../services/multiSymbolLiquidityTracker';
import { getRegimeSignal, RegimeSignal } from '../services/regimeSignal';
import { hyperliquidService } from '../services/hyperliquidService';
import { hyperliquidWsClient } from '../services/hyperliquidWsClient';
import dbService from '../database/dbService';
import { config } from '../utils/config';
import { getCurrentFees, feeBpsRoundTrip, expectedCostBps } from '../utils/fees';
import { logTradeEvent } from './tradeLogger';

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
  
  // Position sizing (read from config, expressed as percent)
  POSITION_SIZE_PERCENT: config.trading.positionSizePercentage / 100, // e.g. 50 -> 0.5
  MAX_POSITIONS: 1,                // Max 1 posizione
  LEVERAGE: parseInt(process.env.MAX_LEVERAGE || '40'), // Leva da .env
  
  // ANTI FLIP-FLOP SETTINGS
  TRADE_COOLDOWN_MS: 120000,       // 120 secondi (2 min) cooldown dopo ogni trade
  SIGNAL_DEBOUNCE_MS: 5000,        // Segnale deve persistere 5 secondi
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

// Lifecycle state for maker-first execution
type SymbolLifecycleState = 'IDLE' | 'ENTERING' | 'OPEN' | 'EXITING' | 'COOLDOWN';

interface ActiveOrder {
  id: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  ts: number;
  intent: 'ENTRY' | 'EXIT';
  requoteCount: number;
}

interface SymbolLifecycle {
  state: SymbolLifecycleState;
  since: number;
  activeOrder?: ActiveOrder;
  lastDecision?: any; // Store last decision for dashboard
}

class EventDrivenTradeLoop extends EventEmitter {
  private isRunning = false;
  private positions: Map<string, Position> = new Map();
  private lastTradeTime: Map<string, number> = new Map();
  private signalBuffer: Map<string, { signal: TradeSignal; firstSeen: number }> = new Map();
  private currentBalance: number = 0;
  private activeOrders: Map<string, { side: 'BUY' | 'SELL'; orderId: string; timestamp: number }> = new Map(); // Track active orders per symbol
  private lastOrderAttempt: Map<string, number> = new Map(); // Track last order attempt timestamp per symbol
  private killSwitchActive: boolean = false;
  
  // ========== MAKER-FIRST STATE ==========
  private lifecycle: Map<string, SymbolLifecycle> = new Map();
  private lastRegimeEvalTs: Map<string, number> = new Map();
  private cachedRegime: Map<string, RegimeSignal> = new Map();
  private lastQuoteActionTs: Map<string, number> = new Map(); // Rate limit cancel/requote
  
  constructor() {
    super();
  }

  /**
   * Emit decision object for logging and UI
   */
  private emitDecision(decision: any): void {
    try {
      this.emit('decision:update', decision);
      const webServer = (global as any).webServer;
      if (webServer && webServer.io) {
        webServer.io.emit('decision:update', decision);
      }
      // Also log if not PASS
      if (decision.reason && decision.reason !== 'PASS' && decision.reason !== 'EVALUATING') {
        logger.debug('Decision', { symbol: decision.symbol, reason: decision.reason, netEdgeBps: decision.netEdgeBps?.toFixed?.(2) ?? 'N/A' });
      }
    } catch (e) {
      // silent
    }
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
      this.syncInterval = setInterval(() => this.syncWithExchange(), 300000); // 5 minutes
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
   * Get consolidated dashboard state for API
   * Returns kill switch, cooldown, per-symbol state, and execution quality data
   */
  async getDashboardState(): Promise<{
    ts: number;
    global: {
      kill_switch_active: boolean;
      kill_switch_reason: string | null;
      trading_enabled: boolean;
      dry_run: boolean;
      balance: number;
      daily_pnl: number;
      max_daily_drawdown_pct: number;
      consecutive_losses: number;
      max_consecutive_losses: number;
      trades_today: number;
      max_trades_per_day: number;
    };
    symbols: Record<string, {
      state: string;
      state_since_ts: number | null;
      cooldown_remaining_ms: number | null;
      open_position: { side: string; size: number; entry_px: number; unrealized_pnl: number } | null;
      last_trade_ts: number | null;
    }>;
    recent_executions: Array<{
      symbol: string;
      side: string;
      size: number;
      fill_px_avg: number;
      slippage_bps: number;
      ts: number;
    }>;
    recent_trades: Array<{
      symbol: string;
      side: string;
      entry_px: number;
      exit_px: number | null;
      pnl: number;
      closed_at: string | null;
    }>;
  }> {
    const stats = await dbService.getDashboardStats();
    const cooldownMs = (config.regime?.cooldownSeconds ?? 600) * 1000;
    const symbols = config.trading.symbols || [];
    
    // Build per-symbol state with maker-first metrics
    const symbolStates: Record<string, any> = {};
    for (const sym of symbols) {
      const pos = this.positions.get(sym);
      const lastTrade = this.lastTradeTime.get(sym) || 0;
      const cooldownRemaining = lastTrade > 0 ? Math.max(0, cooldownMs - (Date.now() - lastTrade)) : null;
      const lc = this.lifecycle.get(sym);
      const lastDecision = lc?.lastDecision;
      
      let state = lc?.state || 'IDLE';
      if (pos) state = 'OPEN';
      else if (cooldownRemaining && cooldownRemaining > 0) state = 'COOLDOWN';
      
      // Get BBO for spread
      const bbo = this.getBboFromWs(sym);
      
      symbolStates[sym] = {
        state,
        state_since_ts: lc?.since || (pos ? pos.openedAt : (lastTrade > 0 ? lastTrade : null)),
        cooldown_remaining_ms: cooldownRemaining,
        open_position: pos ? {
          side: pos.side,
          size: pos.quantity,
          entry_px: pos.entryPrice,
          unrealized_pnl: pos.unrealizedPnl || 0
        } : null,
        last_trade_ts: lastTrade > 0 ? lastTrade : null,
        // Maker-first metrics
        spread_bps: bbo?.spreadBps ?? null,
        expected_move_bps: lastDecision?.expectedMoveBps ?? null,
        expected_cost_bps: lastDecision?.costBps ?? null,
        net_edge_bps: lastDecision?.netEdgeBps ?? null,
        exec_mode: lastDecision?.execMode ?? 'maker',
        last_reason: lastDecision?.reason ?? null,
        active_order: lc?.activeOrder ? {
          intent: lc.activeOrder.intent,
          side: lc.activeOrder.side,
          requested_px: lc.activeOrder.price,
          age_ms: Date.now() - lc.activeOrder.ts
        } : null
      };
    }
    
    // Get recent executions from DB (last 20)
    let recentExecutions: any[] = [];
    try {
      const execs = await dbService.getRecentExecutions(20);
      recentExecutions = (execs || []).map((r: any) => ({
        symbol: r.symbol,
        side: r.side,
        size: parseFloat(r.filled_size || 0),
        fill_px_avg: parseFloat(r.fill_px_avg || 0),
        slippage_bps: parseFloat(r.slippage_bps || 0),
        ts: new Date(r.created_at).getTime()
      }));
    } catch (e) {
      // Table may not exist yet
    }
    
    // Get recent trades
    let recentTrades: any[] = [];
    try {
      const trades = await dbService.getRecentTrades(20);
      recentTrades = (trades || []).map((r: any) => ({
        symbol: r.symbol,
        side: r.side,
        entry_px: parseFloat(r.entry_price || 0),
        exit_px: r.exit_price ? parseFloat(r.exit_price) : null,
        pnl: parseFloat(r.pnl || 0),
        closed_at: r.closed_at
      }));
    } catch (e) {
      // Table may not exist yet
    }
    
    return {
      ts: Date.now(),
      global: {
        kill_switch_active: this.killSwitchActive,
        kill_switch_reason: this.killSwitchActive ? (stats.kill_switch_reason || 'TRIGGERED') : null,
        trading_enabled: config.system.enableLiveTrading,
        dry_run: config.system.dryRun,
        balance: this.currentBalance,
        daily_pnl: parseFloat(stats.today_pnl || 0),
        max_daily_drawdown_pct: config.regime?.maxDailyDrawdownPct ?? 5,
        consecutive_losses: parseInt(stats.consecutive_losses || 0) || 0,
        max_consecutive_losses: config.regime?.maxConsecutiveLosses ?? 3,
        trades_today: parseInt(stats.today_trades || 0) || 0,
        max_trades_per_day: config.regime?.maxTradesPerDay ?? 10
      },
      symbols: symbolStates,
      recent_executions: recentExecutions,
      recent_trades: recentTrades
    };
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
   * Round price to valid tick size for the asset
   */
  private async roundPriceToTick(symbol: string, price: number): Promise<number> {
    return await hyperliquidService.roundPriceToTick(symbol, price);
  }

  /**
   * Handle snapshot event from multiSymbolTracker
   * This is called on EVERY TICK
   */
  private async onSnapshot(data: { symbol: string; snapshot: SymbolSnapshot }): Promise<void> {
    if (!this.isRunning) return;

    const { symbol, snapshot } = data;
    const now = Date.now();

    try {
      const currentPrice = snapshot.currentPrice;
      
      // Initialize lifecycle for symbol if not exists
      if (!this.lifecycle.has(symbol)) {
        this.lifecycle.set(symbol, { state: 'IDLE', since: now });
      }
      const lc = this.lifecycle.get(symbol)!;

      // Handle ENTERING state - check queue discipline
      if (lc.state === 'ENTERING' && lc.activeOrder) {
        await this.handleEnteringState(symbol, lc, currentPrice);
        return; // Don't evaluate new signals while entering
      }

      // Handle EXITING state - check queue discipline
      if (lc.state === 'EXITING' && lc.activeOrder) {
        await this.handleExitingState(symbol, lc, currentPrice);
        return;
      }

      // Throttle regime signal evaluation (not every tick)
      const lastEval = this.lastRegimeEvalTs.get(symbol) || 0;
      const evalIntervalMs = config.regime?.regimeEvalIntervalMs ?? 3000;
      
      let regimeSig: RegimeSignal;
      if (now - lastEval >= evalIntervalMs || !this.cachedRegime.has(symbol)) {
        // Time to re-evaluate regime signal (makes HTTP call)
        regimeSig = await getRegimeSignal(symbol);
        this.cachedRegime.set(symbol, regimeSig);
        this.lastRegimeEvalTs.set(symbol, now);
      } else {
        // Use cached regime signal
        regimeSig = this.cachedRegime.get(symbol)!;
      }

      // Emit a simplified signal for dashboard compatibility
      const tradeSignal: TradeSignal = {
        symbol,
        action: regimeSig.direction === 'LONG' ? 'BUY' : (regimeSig.direction === 'SHORT' ? 'SELL' : 'WAIT'),
        confidence: 100,
        price: currentPrice,
        timestamp: now,
        reasoning: `Regime: compression=${regimeSig.compression} volSpike=${regimeSig.volumeSpike} breakout=${regimeSig.breakout.up || regimeSig.breakout.down}`,
        details: { askSpoofCount: 0, bidSpoofCount: 0, askSpoofVolume: 0, bidSpoofVolume: 0, spoofRatio: 1, highConfidenceAlerts: 0, currentPrice }
      };

      this.emit('signal', tradeSignal);

      const position = this.positions.get(symbol);
      if (position) {
        // Use existing exit logic to manage open positions
        await this.checkExitConditions(position, tradeSignal, currentPrice);
      } else {
        // No open position - evaluate regime signal and possibly enter
        await this.evaluateRegimeAndMaybeOpen(regimeSig);
      }

      // 5. Update P&L for all positions
      await this.updateAllPositionsPnl();

    } catch (error) {
      logger.error(`[EventLoop] Error processing snapshot for ${symbol}:`, error);
    }
  }

  /**
   * Check entry conditions
   */
  // Old wall-pressure entry logic removed; regime-based evaluator is used instead

  /**
   * Get BBO from WebSocket cache with stale check
   */
  private getBboFromWs(symbol: string): { bid: number; ask: number; mid: number; spreadBps: number; ts: number } | null {
    const bbo = hyperliquidWsClient.getBbo(symbol);
    if (!bbo) return null;
    
    const staleMs = config.regime?.dataStaleMs ?? 5000;
    if (Date.now() - bbo.ts > staleMs) return null;
    
    const bid = bbo.bestBid;
    const ask = bbo.bestAsk;
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 0;
    return { bid, ask, mid, spreadBps, ts: bbo.ts };
  }

  /**
   * Handle ENTERING state - check if order filled, timeout, or needs requote
   */
  private async handleEnteringState(symbol: string, lc: SymbolLifecycle, _currentPrice: number): Promise<void> {
    const order = lc.activeOrder!;
    const now = Date.now();
    const maxWait = config.regime?.maxQueueWaitMs ?? 350;
    const orderAge = now - order.ts;

    // Check if order is still resting or filled
    const orderStatus = await hyperliquidService.getOrderStatus(symbol, order.id).catch(() => null);
    
    if (orderStatus?.status === 'filled' || orderStatus?.status === 'unknown') {
      // Order filled or we lost track - sync with exchange
      logger.info('Entry order filled or status unknown, syncing', { symbol, orderId: order.id });
      await this.syncWithExchange();
      lc.state = this.positions.has(symbol) ? 'OPEN' : 'IDLE';
      lc.since = now;
      delete lc.activeOrder;
      return;
    }

    // Check timeout
    if (orderAge > maxWait) {
      // Cancel and decide: requote or give up
      const maxRequotes = config.regime?.maxRequotePerSec ?? 2;
      const lastAction = this.lastQuoteActionTs.get(symbol) || 0;
      const canRequote = (now - lastAction) >= 1000 / maxRequotes && order.requoteCount < 5;

      // Cancel order
      try {
        await hyperliquidService.cancelOrder(order.id, symbol);
        logger.info('Entry order canceled (timeout)', { symbol, orderId: order.id, age: orderAge });
      } catch (e) {
        logger.warn('Failed to cancel entry order', { error: String(e) });
      }

      if (canRequote) {
        // Re-evaluate and requote
        const regime = this.cachedRegime.get(symbol);
        if (regime && regime.direction !== 'NONE' && regime.compression && regime.volumeSpike) {
          await this.placeEntryOrder(symbol, regime, order.size, order.requoteCount + 1);
          this.lastQuoteActionTs.set(symbol, now);
        } else {
          logger.info('Entry conditions no longer valid, returning to IDLE', { symbol });
          lc.state = 'IDLE';
          lc.since = now;
          delete lc.activeOrder;
          this.emitDecision({ ts: now, symbol, reason: 'QUEUE_TIMEOUT', state: 'IDLE' });
        }
      } else {
        // Rate limited or too many requotes
        logger.info('Entry requote rate limited or max reached', { symbol, requotes: order.requoteCount });
        lc.state = 'IDLE';
        lc.since = now;
        delete lc.activeOrder;
        this.emitDecision({ ts: now, symbol, reason: 'RATE_LIMIT', state: 'IDLE' });
      }
    }
  }

  /**
   * Handle EXITING state - check if exit order filled, timeout, or needs requote
   */
  private async handleExitingState(symbol: string, lc: SymbolLifecycle, _currentPrice: number): Promise<void> {
    const order = lc.activeOrder!;
    const now = Date.now();
    const maxWait = config.regime?.maxQueueWaitMs ?? 350;
    const orderAge = now - order.ts;

    const orderStatus = await hyperliquidService.getOrderStatus(symbol, order.id).catch(() => null);
    
    if (orderStatus?.status === 'filled' || orderStatus?.status === 'unknown') {
      // Exit filled
      logger.info('Exit order filled', { symbol, orderId: order.id });
      await this.syncWithExchange();
      lc.state = 'COOLDOWN';
      lc.since = now;
      delete lc.activeOrder;
      return;
    }

    if (orderAge > maxWait) {
      const maxRequotes = config.regime?.maxRequotePerSec ?? 2;
      const lastAction = this.lastQuoteActionTs.get(symbol) || 0;
      const canRequote = (now - lastAction) >= 1000 / maxRequotes && order.requoteCount < 5;

      try {
        await hyperliquidService.cancelOrder(order.id, symbol);
        logger.info('Exit order canceled (timeout)', { symbol, orderId: order.id });
      } catch (e) {
        logger.warn('Failed to cancel exit order', { error: String(e) });
      }

      const position = this.positions.get(symbol);
      if (!position) {
        lc.state = 'IDLE';
        lc.since = now;
        delete lc.activeOrder;
        return;
      }

      // Check if we should taker fallback
      const allowTakerFallback = config.regime?.allowTakerFallback ?? true;
      const takerIfNetEdge = config.regime?.takerOnlyIfNetEdgeBps ?? 20;
      const lastDecision = lc.lastDecision;
      const netEdge = lastDecision?.netEdgeBps ?? 0;

      if (allowTakerFallback && netEdge >= takerIfNetEdge && order.requoteCount >= 2) {
        // Use taker fallback for exit
        logger.info('Exit taker fallback triggered', { symbol, netEdge, requotes: order.requoteCount });
        const exitSide = position.side === 'BUY' ? 'sell' : 'buy';
        const res = await hyperliquidService.exitPosition(symbol, exitSide, position.quantity, { kTicks: 1 });
        
        if (res.ok) {
          this.positions.delete(symbol);
          lc.state = 'COOLDOWN';
          lc.since = now;
          delete lc.activeOrder;
          this.lastTradeTime.set(symbol, now);
          
          // Emit execution report
          this.emit('execution:report', {
            ts: now, symbol, side: exitSide, intended_action: 'EXIT',
            fill_px_avg: res.fillPxAvg, filled_size: res.filledSize,
            maker_taker: 'TAKER_FALLBACK', fee_paid: res.feePaid
          });
        }
      } else if (canRequote) {
        await this.placeExitOrder(symbol, position, order.requoteCount + 1);
        this.lastQuoteActionTs.set(symbol, now);
      } else {
        // Rate limited - stay in EXITING
        logger.warn('Exit requote rate limited', { symbol });
      }
    }
  }

  /**
   * Place maker entry order using post-only limit
   */
  private async placeEntryOrder(symbol: string, regime: RegimeSignal, size: number, requoteCount: number): Promise<void> {
    const now = Date.now();
    const lc = this.lifecycle.get(symbol)!;
    const side = regime.direction === 'LONG' ? 'buy' : 'sell';
    
    const bbo = this.getBboFromWs(symbol);
    if (!bbo) {
      logger.warn('No BBO for entry order', { symbol });
      lc.state = 'IDLE';
      lc.since = now;
      this.emitDecision({ ts: now, symbol, reason: 'DATA_STALE', state: 'IDLE' });
      return;
    }

    const tickSize = await hyperliquidService.getTickSizePublic(symbol);
    const offset = config.regime?.quoteTickOffset ?? 1;
    
    // Maker price: sit on our side of the book
    let entryPx = side === 'buy' 
      ? bbo.bid + offset * tickSize  // Join bid side
      : bbo.ask - offset * tickSize; // Join ask side
    
    entryPx = await hyperliquidService.roundPriceToTick(symbol, entryPx);

    logger.info('Placing maker entry order', { symbol, side, size, entryPx, bid: bbo.bid, ask: bbo.ask, requoteCount });

    const res = await hyperliquidService.placePostOnlyLimit(symbol, side, size, entryPx, { reduceOnly: false });

    if (res.ok && res.status === 'resting') {
      lc.state = 'ENTERING';
      lc.since = now;
      lc.activeOrder = {
        id: res.orderId,
        side,
        price: entryPx,
        size,
        ts: now,
        intent: 'ENTRY',
        requoteCount
      };
      logger.info('Entry order resting', { symbol, orderId: res.orderId, price: entryPx });
    } else if (res.status === 'filled') {
      // Rare: filled immediately as maker
      logger.info('Entry order filled immediately (maker)', { symbol });
      await this.syncWithExchange();
      lc.state = this.positions.has(symbol) ? 'OPEN' : 'IDLE';
      lc.since = now;
    } else {
      // Rejected
      logger.warn('Entry order rejected', { symbol, reason: res.reason });
      lc.state = 'IDLE';
      lc.since = now;
      this.emitDecision({ ts: now, symbol, reason: 'POST_ONLY_REJECT', state: 'IDLE' });
    }
  }

  /**
   * Place maker exit order using post-only limit
   */
  private async placeExitOrder(symbol: string, position: Position, requoteCount: number): Promise<void> {
    const now = Date.now();
    const lc = this.lifecycle.get(symbol)!;
    const exitSide = position.side === 'BUY' ? 'sell' : 'buy';
    
    const bbo = this.getBboFromWs(symbol);
    if (!bbo) {
      logger.warn('No BBO for exit order', { symbol });
      return; // Stay in EXITING, will retry
    }

    const tickSize = await hyperliquidService.getTickSizePublic(symbol);
    const offset = config.regime?.quoteTickOffset ?? 1;
    
    // Maker price for exit
    let exitPx = exitSide === 'sell'
      ? bbo.ask - offset * tickSize  // Join ask side to sell
      : bbo.bid + offset * tickSize; // Join bid side to buy back
    
    exitPx = await hyperliquidService.roundPriceToTick(symbol, exitPx);

    logger.info('Placing maker exit order', { symbol, side: exitSide, size: position.quantity, exitPx, bid: bbo.bid, ask: bbo.ask, requoteCount });

    const res = await hyperliquidService.placePostOnlyLimit(symbol, exitSide, position.quantity, exitPx, { reduceOnly: true });

    if (res.ok && res.status === 'resting') {
      lc.activeOrder = {
        id: res.orderId,
        side: exitSide,
        price: exitPx,
        size: position.quantity,
        ts: now,
        intent: 'EXIT',
        requoteCount
      };
      logger.info('Exit order resting', { symbol, orderId: res.orderId, price: exitPx });
    } else if (res.status === 'filled') {
      logger.info('Exit order filled immediately (maker)', { symbol });
      await this.syncWithExchange();
      this.positions.delete(symbol);
      lc.state = 'COOLDOWN';
      lc.since = now;
      delete lc.activeOrder;
      this.lastTradeTime.set(symbol, now);
    }
  }

  /**
   * Evaluate regime signal and attempt entry if gate passes
   * MAKER-FIRST EXECUTION
   * Skip reasons with strict precedence:
   * 1. DATA_STALE
   * 2. KILL_SWITCH
   * 3. DAILY_LIMIT
   * 4. COOLDOWN
   * 5. FAIL_COMPRESSION
   * 6. FAIL_VOLUME
   * 7. FAIL_BREAKOUT
   * 8. SPREAD_TOO_WIDE
   * 9. FAIL_EDGE
   * 10. PASS
   */
  private async evaluateRegimeAndMaybeOpen(regimeSig: RegimeSignal): Promise<void> {
    const { symbol, compression, volumeSpike, direction, metrics, ts } = regimeSig;
    const price = metrics.price;
    const now = Date.now();
    
    // Get BBO for spread calculation
    const bbo = this.getBboFromWs(symbol);
    const spreadBps = bbo?.spreadBps ?? (config.regime?.spreadBpsEst ?? 2);
    
    // Determine execution mode
    const makerFirst = config.regime?.makerFirst ?? true;
    const execMode: 'maker' | 'taker' = makerFirst ? 'maker' : 'taker';
    
    // Build decision object for logging/emit
    const decision: any = {
      ts: now,
      symbol,
      compression,
      volumeSpike,
      breakoutDirection: direction,
      vol5m: metrics.vol5m,
      vol30m: metrics.vol30m,
      volume1m: metrics.volume1m,
      avgVol15m: metrics.avgVol15m,
      spreadBps,
      execMode,
      expectedMoveBps: undefined,
      costBps: undefined,
      netEdgeBps: undefined,
      reason: 'EVALUATING',
      state: 'IDLE'
    };

    // Store decision for dashboard
    const lc = this.lifecycle.get(symbol);
    if (lc) lc.lastDecision = decision;

    // 1. DATA_STALE check
    const dataAge = now - ts;
    const dataStaleMs = config.regime?.dataStaleMs ?? 5000;
    if (dataAge > dataStaleMs || !bbo) {
      decision.reason = 'DATA_STALE';
      this.emitDecision(decision);
      return;
    }

    // 2. KILL_SWITCH check
    if (this.killSwitchActive) {
      decision.reason = 'KILL_SWITCH';
      this.emitDecision(decision);
      return;
    }

    // 3. DAILY_LIMIT and kill-switch checks from DB
    try {
      const dashboard = await dbService.getDashboardStats();
      const stats = await dbService.getTradeStats();
      const todayTrades = parseInt(dashboard.today_trades) || 0;
      const todayPnl = parseFloat(dashboard.today_pnl) || 0;
      const consecutiveLosses = stats.consecutiveLosses || 0;

      if (todayTrades >= (config.regime?.maxTradesPerDay ?? 2)) {
        decision.reason = 'DAILY_LIMIT';
        this.emitDecision(decision);
        return;
      }

      const starting = config.trading.startingBalance || 0;
      if (starting > 0 && todayPnl <= -((config.regime?.maxDailyDrawdownPct ?? 2.5) / 100) * starting) {
        logger.error('KILL_SWITCH: daily drawdown exceeded', { todayPnl, thresholdPct: config.regime?.maxDailyDrawdownPct });
        this.killSwitchActive = true;
        decision.reason = 'KILL_SWITCH';
        this.emitDecision(decision);
        return;
      }

      if (consecutiveLosses >= (config.regime?.maxConsecutiveLosses ?? 3)) {
        logger.error('KILL_SWITCH: consecutive losses threshold reached', { consecutiveLosses });
        this.killSwitchActive = true;
        decision.reason = 'KILL_SWITCH';
        this.emitDecision(decision);
        return;
      }
    } catch (err) {
      logger.warn('Failed to fetch DB stats for kill-switch', { error: String(err) });
    }

    // 4. COOLDOWN check
    const lastTrade = this.lastTradeTime.get(symbol) || 0;
    const cooldownMs = (config.regime?.cooldownSeconds ?? 600) * 1000;
    if (now - lastTrade < cooldownMs) {
      decision.reason = 'COOLDOWN';
      decision.cooldownRemainingMs = cooldownMs - (now - lastTrade);
      this.emitDecision(decision);
      return;
    }

    // 5. FAIL_COMPRESSION
    if (!compression) {
      decision.reason = 'FAIL_COMPRESSION';
      this.emitDecision(decision);
      return;
    }

    // 6. FAIL_VOLUME
    if (!volumeSpike) {
      decision.reason = 'FAIL_VOLUME';
      this.emitDecision(decision);
      return;
    }

    // 7. FAIL_BREAKOUT
    if (direction === 'NONE') {
      decision.reason = 'FAIL_BREAKOUT';
      this.emitDecision(decision);
      return;
    }

    // 8. SPREAD_TOO_WIDE check
    const maxSpread = config.regime?.spreadBpsEstMax ?? 5;
    if (spreadBps > maxSpread) {
      decision.reason = 'SPREAD_TOO_WIDE';
      logger.info('SPREAD_TOO_WIDE', { symbol, spreadBps: spreadBps.toFixed(2), maxSpread });
      this.emitDecision(decision);
      return;
    }

    // 9. FAIL_EDGE: Edge gate calculation with maker/taker cost model
    const vol30 = metrics.vol30m || 0.0001;
    const holdingFactor = Math.max(1, (config.regime?.maxHoldSeconds ?? 900) / 60);
    const expectedMoveBps = vol30 * Math.sqrt(holdingFactor) * 10000;
    decision.expectedMoveBps = expectedMoveBps;

    // Position sizing
    const atr5 = metrics.vol5m || 0.0001;
    const stopDistancePx = (config.regime?.stopAtrMult ?? 0.35) * atr5 * price;
    if (stopDistancePx <= 0) {
      logger.warn('Invalid stop distance computed, aborting entry', { symbol, stopDistancePx });
      decision.reason = 'FAIL_EDGE';
      this.emitDecision(decision);
      return;
    }

    const riskAmount = this.currentBalance * ((config.regime?.riskPerTradePct ?? 0.3) / 100);
    let quantity = (riskAmount) / stopDistancePx;
    const maxPos = config.trading.maxPositionSize || quantity * 10;
    if (quantity * price > maxPos) {
      quantity = maxPos / price;
    }

    const minOrder = await hyperliquidService.getMinOrderSize(symbol);
    if (quantity < minOrder) quantity = minOrder;

    // Fee-aware cost calculation
    const makerFeeBps = config.regime?.makerFeeBps ?? -1;
    const takerFeeBps = config.regime?.takerFeeBps ?? 6;
    const slippageBpsEst = config.regime?.slippageBpsEst ?? 4;
    
    const costBps = expectedCostBps(execMode, spreadBps, makerFeeBps, takerFeeBps, slippageBpsEst);
    decision.costBps = costBps;

    const netEdgeBps = expectedMoveBps - costBps;
    decision.netEdgeBps = netEdgeBps;

    const minNetEdge = config.regime?.minNetEdgeBps ?? 12;
    if (netEdgeBps < minNetEdge) {
      logger.info('FAIL_EDGE', { symbol, expectedMoveBps: expectedMoveBps.toFixed(2), costBps: costBps.toFixed(2), netEdgeBps: netEdgeBps.toFixed(2), minNetEdgeBps: minNetEdge, execMode });
      decision.reason = 'FAIL_EDGE';
      this.emitDecision(decision);
      return;
    }

    // 10. PASS - all gates passed
    decision.reason = 'PASS';
    decision.state = 'ENTERING';
    if (lc) lc.lastDecision = decision;
    this.emitDecision(decision);

    // Emit gate evaluation for UI
    try {
      const gateEval = {
        ts: now,
        symbol,
        expected_move_bps: expectedMoveBps,
        cost_bps_total: costBps,
        cost_breakdown: { 
          fee_bps: feeBpsRoundTrip(execMode, makerFeeBps, takerFeeBps), 
          spread_bps: spreadBps,
          slippage_bps_est: execMode === 'maker' ? 0.2 * slippageBpsEst : slippageBpsEst
        },
        net_edge_bps: netEdgeBps,
        exec_mode: execMode,
        pass: true,
        reason: 'PASS'
      };
      this.emit('gate:evaluation', gateEval);
      const webServer = (global as any).webServer;
      if (webServer && webServer.io) webServer.io.emit('gate:evaluation', gateEval);
    } catch (e) {
      logger.warn('Failed to emit gate evaluation', { error: String(e) });
    }

    const side = direction === 'LONG' ? 'buy' : 'sell';

    logger.info('Entry PASS (maker-first)', { symbol, side, quantity, stopDistancePx, expectedMoveBps: expectedMoveBps.toFixed(2), costBps: costBps.toFixed(2), netEdgeBps: netEdgeBps.toFixed(2), execMode, spreadBps: spreadBps.toFixed(2) });

    // Set leverage
    await hyperliquidService.setLeverage(symbol, config.regime?.leverage ?? 8);

    // MAKER-FIRST: Place post-only limit order
    if (makerFirst) {
      await this.placeEntryOrder(symbol, regimeSig, quantity, 0);
      return;
    }

    // TAKER fallback (legacy path)
    try {
      await hyperliquidService.setLeverage(symbol, config.regime?.leverage ?? 8);
      const res = await hyperliquidService.enterPosition(symbol, side as 'buy' | 'sell', quantity, { kTicks: config.regime?.executionTicks ?? 1 });
      
      if (res && res.skipped) {
        logger.info('Entry skipped by execution layer', { res });
        decision.reason = res.reason || 'ENTRY_SKIPPED';
        decision.state = 'IDLE';
        this.emitDecision(decision);
        return;
      }

      if (res && !res.ok && res.status === 'unfilled') {
        logger.info('Entry not filled (IOC unfilled)', { res });
        decision.reason = 'ENTRY_NOT_FILLED';
        decision.state = 'IDLE';
        this.emitDecision(decision);
        return;
      }

      // Emit execution report for entry
      try {
        const execReport = {
          ts: Date.now(),
          symbol,
          side: side === 'buy' ? 'buy' : 'sell',
          intended_action: 'ENTRY',
          requested_px: res.requestedPx || res.requested_px || res.requestedPx,
          fill_px_avg: res.fillPxAvg || res.fill_px_avg || res.fillPxAvg || res.requestedPx,
          filled_size: res.filledSize || res.filled_size || quantity,
          maker_taker: (res.makerTaker || res.maker_taker || 'UNKNOWN').toUpperCase(),
          fee_paid: res.feePaid || res.fee_paid || 0,
          fee_bps: 0,
          slippage_bps: res.slippageBps || res.slippage_bps || 0,
        } as any;
        this.emit('execution:report', execReport);
        const webServer = (global as any).webServer;
        if (webServer && webServer.io) webServer.io.emit('execution:report', execReport);
        // Persist execution
        await dbService.saveExecution(execReport).catch(err => logger.warn('Failed to persist execution report', { error: String(err) }));
      } catch (e) {
        logger.warn('Failed to emit/persist entry execution report', { error: String(e) });
      }

      const fillPx = res.fillPxAvg || res.requestedPx;
      const filledSize = res.filledSize || quantity;

      // Compute TP/SL
      const stopPx = side === 'buy' ? fillPx - stopDistancePx : fillPx + stopDistancePx;
      const tpPx = side === 'buy' ? fillPx + (config.regime!.tpRMult * stopDistancePx) : fillPx - (config.regime!.tpRMult * stopDistancePx);

      const position = {
        id: `pos_${Date.now()}_${symbol}`,
        symbol,
        side: side === 'buy' ? 'BUY' : 'SELL',
        entryPrice: fillPx,
        quantity: filledSize,
        leverage: config.regime!.leverage,
        openedAt: Date.now(),
        takeProfitPrice: tpPx,
        stopLossPrice: stopPx,
        lastSignal: side === 'buy' ? 'BUY' : 'SELL',
        unrealizedPnl: 0,
        maxPnlPercent: 0,
        trailingActivated: false,
      };

      this.positions.set(symbol, position as Position);
      this.lastTradeTime.set(symbol, Date.now());

      logger.info('Position opened (regime)', { symbol, exec: res as any, position: JSON.stringify(position) });
        // Emit lifecycle update: OPEN
        try {
          const lifecycle = {
            state: 'OPEN',
            state_since_ts: Date.now(),
            open_position: {
              side: position.side === 'BUY' ? 'buy' : 'sell',
              size: position.quantity,
              entry_px: position.entryPrice,
              entry_ts: position.openedAt,
              leverage: position.leverage,
              notional: position.quantity * position.entryPrice,
            }
          } as any;
          this.emit('lifecycle:update', { symbol, lifecycle });
          const webServer = (global as any).webServer;
          if (webServer && webServer.io) webServer.io.emit('lifecycle:update', { symbol, lifecycle });
        } catch (e) {
          logger.warn('Failed to emit lifecycle update on open', { error: String(e) });
        }
      // Structured log for entry
      try {
        logTradeEvent('entry', {
          tradeId: position.id,
          symbol,
          side,
          requestedPx: res.requestedPx,
          fillPxAvg: res.fillPxAvg,
          filledSize: res.filledSize,
          makerTaker: res.makerTaker,
          feePaid: res.feePaid,
          slippageBps: res.slippageBps,
          expectedMoveBps,
          costBps,
          signal: regimeSig,
        });
      } catch (e) {
        logger.warn('Failed to write trade entry log', { error: String(e) });
      }

      // Persist to DB
      try {
        await this.savePositionToDb(position as Position);
        // Persist state machine
        try {
          await dbService.setPositionState(position.id, symbol, 'OPEN');
        } catch (e) {
          logger.warn('Failed to persist position state', { error: String(e) });
        }
      } catch (err) {
        logger.warn('Failed to save position to DB', { error: String(err) });
      }

    } catch (err) {
      logger.error('Failed to execute regime entry', { symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Check exit conditions for an open position
   */
  private async checkExitConditions(position: Position, signal: TradeSignal, currentPrice: number): Promise<void> {
    // Use per-position TP/SL
    const holdTime = Date.now() - position.openedAt;

    // If reached stop loss price
    if ((position.side === 'BUY' && currentPrice <= position.stopLossPrice) ||
        (position.side === 'SELL' && currentPrice >= position.stopLossPrice)) {
      await this.closePosition(position, currentPrice, `🛑 SL triggered`);
      return;
    }

    // If reached take profit price
    if ((position.side === 'BUY' && currentPrice >= position.takeProfitPrice) ||
        (position.side === 'SELL' && currentPrice <= position.takeProfitPrice)) {
      await this.closePosition(position, currentPrice, `🎯 TP reached`);
      return;
    }

    // Trailing stop handled by previous maxPnlPercent logic retained per-position
    // Update max P&L percent for trailing
    const priceDiff = position.side === 'BUY'
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;
    const pnlPercent = priceDiff * 100;
    if (pnlPercent > position.maxPnlPercent) position.maxPnlPercent = pnlPercent;

    // Trailing close (use previous TRADE_CONFIG distances but conservative)
    const TRAIL_DROP_PCT = 0.04; // 4% price drop from max pnl percent (configurable later)
    if (position.maxPnlPercent - pnlPercent >= TRAIL_DROP_PCT && pnlPercent > 0) {
      await this.closePosition(position, currentPrice, `📉 Trailing drop`);
      return;
    }

    // Wall-pressure / spoofing based exits removed — regime-driven signals and TP/SL/trailing govern exits

    // 5. Minimum hold time (anti flip-flop)
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
    const { symbol, action, price: rawPrice, confidence, reasoning } = signal;
    
    // Round price to valid tick size
    logger.debug(`[EventLoop] openPosition: Raw price from signal: ${rawPrice}`);
    const price = await this.roundPriceToTick(symbol, rawPrice);
    logger.debug(`[EventLoop] openPosition: Rounded price: ${price}`);
    
    // Calculate position size - ensure minimum order size
    // Apply optional multiplier from config for quick scaling
    const effectivePositionPercent = TRADE_CONFIG.POSITION_SIZE_PERCENT * (config.trading.positionSizeMultiplier || 1);
    let marginValue = this.currentBalance * effectivePositionPercent;
    
    // Calculate quantity: (margine * leva) / prezzo
    let quantity = (marginValue * TRADE_CONFIG.LEVERAGE) / price;
    
    // Round quantity to 5 decimal places to avoid precision issues
    quantity = parseFloat(quantity.toFixed(5));

    logger.info(`[EventLoop] Computed sizing`, { currentBalance: this.currentBalance, effectivePositionPercent, marginValue, quantity });

    // Get minimum order size for this asset
    const minOrderSize = await hyperliquidService.getMinOrderSize(symbol);
    if (quantity < minOrderSize) {
      // If quantity is too small, use minimum order size
      quantity = minOrderSize;
      marginValue = (quantity * price) / TRADE_CONFIG.LEVERAGE;
      logger.info(`Adjusted position size to minimum order size`, { 
        symbol, 
        originalMargin: (this.currentBalance * TRADE_CONFIG.POSITION_SIZE_PERCENT), 
        adjustedQuantity: quantity,
        minOrderSize 
      });
    }

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
      // Mark order as active
      this.activeOrders.set(symbol, { 
        side: action as 'BUY' | 'SELL', 
        orderId: `order_${Date.now()}`, 
        timestamp: Date.now() 
      });
      this.lastOrderAttempt.set(symbol, Date.now());

      try {
        // Set leverage first
        await hyperliquidService.setLeverage(symbol, TRADE_CONFIG.LEVERAGE);

        const side = action === 'BUY' ? 'buy' : 'sell';
        let orderPrice = signal.details?.currentPrice || 0;
        logger.debug(`[EventLoop] Signal details currentPrice: ${signal.details?.currentPrice}, using: ${orderPrice}`);
        logger.info(`[EventLoop] Placing order with signal price: ${orderPrice}, action: ${action}`);
        
        // If no valid price from signal, get current market price
        if (orderPrice <= 0) {
          try {
            const book = await hyperliquidService.getBestBidAsk(symbol);
            orderPrice = (book.bid + book.ask) / 2;
            logger.info(`[EventLoop] Using market price: ${orderPrice}`);
          } catch (err) {
            logger.error('[EventLoop] Failed to get market price for order', err);
            return; // Cannot place order without price
          }
        }
        
        // Round to tick size (BTC: 0.5, others: 0.01)
        const baseAsset = symbol.split('-')[0];
        const tickSize = baseAsset === 'BTC' ? 0.5 : 0.01;
        logger.debug(`[EventLoop] Before tick rounding: orderPrice = ${orderPrice}, tickSize = ${tickSize}`);
        orderPrice = Math.round(orderPrice / tickSize) * tickSize;
        logger.info(`[EventLoop] Final order price after tick rounding: ${orderPrice}`);
        
        const orderResult = await hyperliquidService.placeOrder(symbol, side, quantity, orderPrice, false); // Use market order
        // If execution was skipped due to slippage guard, abort the trade
        if (orderResult && (orderResult as any).skipped) {
          logger.warn(`[EventLoop] Aborting trade - execution skipped`, { symbol, side, reason: (orderResult as any).reason, slippageBps: (orderResult as any).slippageBps });
          this.activeOrders.delete(symbol);
          return; // abort trade
        }

        logger.info(`[EventLoop] Order placed on exchange: ${side} ${quantity} ${symbol}`, { ...orderResult });

        // Update position with actual execution details
        if (orderResult.price) position.entryPrice = orderResult.price;
        if (orderResult.quantity) position.quantity = orderResult.quantity;
        
        // Recalculate TP/SL based on actual entry price
        position.takeProfitPrice = position.entryPrice * tpMultiplier;
        position.stopLossPrice = position.entryPrice * slMultiplier;
        
      } catch (error) {
        // Remove active order on failure
        this.activeOrders.delete(symbol);
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

    // Remove active order since position is now open
    this.activeOrders.delete(symbol);
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
    // Calculate fees using current fee schedule
    const fees = getCurrentFees();
    const entryFee = quantity * entryPrice * fees.takerRate;
    const exitFee = quantity * currentPrice * fees.takerRate;
    const totalFees = entryFee + exitFee;

    // Net P&L after fees
    const netPnl = grossPnl - totalFees;

    // Remove position
    this.positions.delete(symbol);
    this.lastTradeTime.set(symbol, Date.now());

    // Update balance (net of fees)
    this.currentBalance += netPnl;

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

    // Structured log for exit
    try {
      logTradeEvent('exit', {
        tradeId: position.id,
        symbol,
        side,
        entryPrice,
        exitPrice: currentPrice,
        quantity,
        grossPnl,
        totalFees,
        netPnl,
        reason,
        ts: Date.now(),
      });
    } catch (e) {
      logger.warn('Failed to write trade exit log', { error: String(e) });
    }

    // Emit lifecycle update: CLOSED
    try {
      const lifecycle = {
        state: 'CLOSED',
        state_since_ts: Date.now(),
        open_position: null
      } as any;
      this.emit('lifecycle:update', { symbol, lifecycle });
      const webServer = (global as any).webServer;
      if (webServer && webServer.io) webServer.io.emit('lifecycle:update', { symbol, lifecycle });
    } catch (e) {
      logger.warn('Failed to emit lifecycle update on close', { error: String(e) });
    }

    // Emit execution report for exit
    try {
      const execReport = {
        ts: Date.now(),
        symbol,
        side: side === 'BUY' ? 'sell' : 'buy',
        intended_action: 'EXIT',
        requested_px: currentPrice,
        fill_px_avg: currentPrice,
        filled_size: quantity,
        maker_taker: 'TAKER',
        fee_paid: totalFees,
        fee_bps: 0,
        slippage_bps: 0,
      } as any;
      this.emit('execution:report', execReport);
      const webServer = (global as any).webServer;
      if (webServer && webServer.io) webServer.io.emit('execution:report', execReport);
      await dbService.saveExecution(execReport).catch(err => logger.warn('Failed to persist exit execution', { error: String(err) }));
    } catch (e) {
      logger.warn('Failed to emit/persist exit execution report', { error: String(e) });
    }

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
      try {
        await dbService.setPositionState(position.id, position.symbol, 'CLOSED');
      } catch (e) {
        logger.warn('Failed to update position state on close', { error: String(e) });
      }
    } catch (error) {
      logger.error('[EventLoop] Failed to update DB on close:', error);
    }

    // Remove any active order for this symbol
    this.activeOrders.delete(symbol);
  }

  /**
   * Update P&L for all open positions
   */


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

  private async updateAllPositionsPnl(): Promise<void> {
    const promises = [];
    for (const [symbol, position] of this.positions.entries()) {
      promises.push(
        hyperliquidService.getTickerPrice(symbol).then(currentPrice => {
          if (currentPrice) {
            const priceDiff = position.side === 'BUY'
              ? currentPrice - position.entryPrice
              : position.entryPrice - currentPrice;
            position.unrealizedPnl = priceDiff * position.quantity * position.leverage;
          }
        }).catch(err => {
          logger.warn(`Failed to get price for ${symbol} P&L update:`, err);
        })
      );
    }

    await Promise.all(promises);

    // Emit positions update
    this.emit('positions', this.getPositionsSummary());
  }

  /**
   * Get current signals for all symbols
   */
  getCurrentSignals(): Record<string, TradeSignal> {
    const signals: Record<string, TradeSignal> = {};
    for (const symbol of config.trading.symbols) {
      const snapshot = multiSymbolTracker.getSnapshot(symbol);
      signals[symbol] = {
        symbol,
        action: 'WAIT',
        confidence: 0,
        price: snapshot?.currentPrice || 0,
        timestamp: Date.now(),
        reasoning: 'Regime signals available via /api/regime or websocket updates',
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
    
    // Retry logic with exponential backoff
    const maxRetries = 3;
    const baseTimeoutMs = 30000; // 30s initial timeout
    
    let account: any = null;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const timeoutMs = baseTimeoutMs * attempt; // 30s, 60s, 90s
      try {
        account = await Promise.race([
          hyperliquidService.getAccount(),
          new Promise<any>((_, reject) => 
            setTimeout(() => reject(new Error(`Timeout after ${timeoutMs/1000}s (attempt ${attempt}/${maxRetries})`)), timeoutMs)
          )
        ]);
        break; // Success, exit retry loop
      } catch (err) {
        lastError = err as Error;
        logger.warn(`[EventLoop] Sync attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000 * attempt)); // Wait 2s, 4s before retry
        }
      }
    }
    
    if (!account) {
      logger.error('[EventLoop] Failed to sync with Hyperliquid after all retries', { error: lastError?.message });
      return; // Don't crash, just skip this sync cycle
    }
    
    try {
      const activeTrades = await dbService.getActiveTrades();
      const dbMap = new Map<string, any>();
      for (const trade of activeTrades) {
        dbMap.set(trade.symbol, trade);
      }
      
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

      logger.info('[EventLoop] Sync with Hyperliquid completed successfully');

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
