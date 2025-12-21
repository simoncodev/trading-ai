import { Pool } from 'pg';
import { logger } from '../core/logger';
import { TradeDecision, OrderResponse, Account } from '../types';

/**
 * Database service for PostgreSQL operations
 */
class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'trading_ai_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err: Error) => {
      logger.error('Unexpected database error', err);
    });
  }

  /**
   * Initialize database connection
   */
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.info('Database connected successfully');
    } catch (error) {
      logger.error('Failed to connect to database', error);
      throw error;
    }
  }

  /**
   * Close database connection
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
    logger.info('Database disconnected');
  }

  /**
   * Save a trade to database
   */
  async saveTrade(order: OrderResponse, decision: TradeDecision, leverage?: number): Promise<void> {
    try {
      const query = `
        INSERT INTO trades (
          trade_id, symbol, side, order_type, quantity, entry_price,
          stop_loss, take_profit, status, fee, leverage, executed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (trade_id) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = NOW()
      `;

      const values = [
        order.orderId,
        order.symbol,
        order.side,
        order.type,
        order.quantity,
        order.price,
        decision.indicators.bollingerBands?.lower || null,
        decision.indicators.bollingerBands?.upper || null,
        (order.status === 'filled' || order.status === 'partial') ? 'open' : 'pending',
        order.fee,
        leverage || null,
        new Date(order.timestamp),
      ];

      await this.pool.query(query, values);
      logger.info('Trade saved to database', { tradeId: order.orderId });
    } catch (error) {
      logger.error('Failed to save trade', error);
    }
  }

  /**
   * Save AI decision to database
   */
  async saveAIDecision(decision: TradeDecision, tradeId?: string): Promise<void> {
    try {
      const query = `
        INSERT INTO ai_decisions (
          symbol, decision, confidence, reasoning, current_price,
          suggested_price, suggested_quantity, stop_loss, take_profit,
          executed, trade_id, rsi, macd, macd_signal, macd_histogram,
          ema_12, ema_26, bb_upper, bb_middle, bb_lower
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      `;

      const values = [
        decision.symbol,
        decision.decision,
        decision.confidence,
        decision.reasoning,
        decision.currentPrice,
        null, // suggested_price
        null, // suggested_quantity
        null, // stop_loss
        null, // take_profit
        decision.executed,
        tradeId || null,
        decision.indicators.rsi,
        decision.indicators.macd.macd,
        decision.indicators.macd.signal,
        decision.indicators.macd.histogram,
        decision.indicators.ema12,
        decision.indicators.ema26,
        decision.indicators.bollingerBands.upper,
        decision.indicators.bollingerBands.middle,
        decision.indicators.bollingerBands.lower,
      ];

      await this.pool.query(query, values);
      logger.debug('AI decision saved to database');
    } catch (error) {
      logger.error('Failed to save AI decision', error);
    }
  }

  /**
   * Save market snapshot
   */
  async saveMarketSnapshot(
    symbol: string,
    price: number,
    volume24h: number,
    priceChange24h: number,
    volatility: number
  ): Promise<void> {
    try {
      const query = `
        INSERT INTO market_snapshots (symbol, price, volume_24h, price_change_24h, volatility)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await this.pool.query(query, [symbol, price, volume24h, priceChange24h, volatility]);
    } catch (error) {
      logger.error('Failed to save market snapshot', error);
    }
  }

  /**
   * Save account history
   */
  async saveAccountHistory(account: Account): Promise<void> {
    try {
      const query = `
        INSERT INTO account_history (balance, available_balance, total_pnl, daily_pnl, open_positions)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await this.pool.query(query, [
        account.balance,
        account.availableBalance,
        account.totalPnL,
        account.dailyPnL,
        account.positions.length,
      ]);
    } catch (error) {
      logger.error('Failed to save account history', error);
    }
  }

  /**
   * Update trade status and P&L
   */
  async updateTrade(
    tradeId: string,
    exitPrice: number,
    pnl: number,
    status: 'closed' | 'cancelled'
  ): Promise<void> {
    try {
      const query = `
        UPDATE trades 
        SET exit_price = $1, pnl = $2, status = $3, closed_at = NOW(), 
            pnl_percentage = (($1 - entry_price) / entry_price * 100)
        WHERE trade_id = $4
      `;

      await this.pool.query(query, [exitPrice, pnl, status, tradeId]);
      logger.info('Trade updated', { tradeId, status });
    } catch (error) {
      logger.error('Failed to update trade', error);
    }
  }

  /**
   * Get recent trades
   */
  async getRecentTrades(limit = 50): Promise<any[]> {
    const query = `
      SELECT * FROM trades 
      ORDER BY executed_at DESC 
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Get recent CLOSED trades (for dashboard Last Trades section)
   */
  async getRecentClosedTrades(limit = 10): Promise<any[]> {
    const query = `
      SELECT * FROM trades 
      WHERE status = 'closed'
      ORDER BY closed_at DESC 
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Get recent AI decisions
   */
  async getRecentDecisions(limit = 50): Promise<any[]> {
    const query = `
      SELECT * FROM ai_decisions 
      ORDER BY created_at DESC 
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  /**
   * Get active trades
   */
  async getActiveTrades(): Promise<any[]> {
    const query = `SELECT * FROM v_active_trades`;
    const result = await this.pool.query(query);
    return result.rows;
  }

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(): Promise<any> {
    // Calculate metrics directly from trades table
    const query = `
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losing_trades,
        CASE WHEN COUNT(*) > 0 
          THEN ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric, 4)
          ELSE 0 
        END as win_rate,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(AVG(pnl), 0) as avg_pnl,
        COALESCE(MAX(pnl), 0) as best_trade,
        COALESCE(MIN(pnl), 0) as worst_trade,
        -- Calculate Sharpe Ratio (simplified: avg return / stddev)
        CASE WHEN STDDEV(pnl) > 0 
          THEN ROUND((AVG(pnl) / STDDEV(pnl))::numeric, 4)
          ELSE 0 
        END as sharpe_ratio
      FROM trades
      WHERE status = 'closed'
    `;
    const result = await this.pool.query(query);
    const metrics = result.rows[0];
    
    // Calculate max drawdown separately with proper subquery
    const ddQuery = `
      WITH cumulative AS (
        SELECT 
          executed_at,
          pnl,
          SUM(pnl) OVER (ORDER BY executed_at) as running_total
        FROM trades 
        WHERE status = 'closed'
      ),
      peaks AS (
        SELECT 
          running_total,
          MAX(running_total) OVER (ORDER BY executed_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as peak
        FROM cumulative
      )
      SELECT COALESCE(MAX(peak - running_total), 0) as max_drawdown
      FROM peaks
    `;
    
    try {
      const ddResult = await this.pool.query(ddQuery);
      metrics.max_drawdown = ddResult.rows[0]?.max_drawdown || 0;
    } catch (e) {
      metrics.max_drawdown = 0;
    }
    
    return metrics;
  }

  /**
   * Get daily performance
   */
  async getDailyPerformance(days = 30): Promise<any[]> {
    const query = `SELECT * FROM v_daily_performance LIMIT $1`;
    const result = await this.pool.query(query, [days]);
    return result.rows;
  }

  /**
   * Get latest market snapshot
   */
  async getLatestMarketSnapshot(symbol: string): Promise<any> {
    const query = `
      SELECT * FROM market_snapshots 
      WHERE symbol = $1 
      ORDER BY timestamp DESC 
      LIMIT 1
    `;
    const result = await this.pool.query(query, [symbol]);
    return result.rows[0];
  }

  /**
   * Get account balance history
   */
  async getAccountHistory(hours = 24): Promise<any[]> {
    const query = `
      SELECT * FROM account_history 
      WHERE timestamp >= NOW() - INTERVAL '${hours} hours'
      ORDER BY timestamp DESC
    `;
    const result = await this.pool.query(query);
    return result.rows;
  }

  /**
   * Save system log
   */
  async saveLog(level: string, message: string, metadata?: any): Promise<void> {
    try {
      const query = `
        INSERT INTO system_logs (level, message, metadata)
        VALUES ($1, $2, $3)
      `;
      await this.pool.query(query, [level, message, metadata || {}]);
    } catch (error) {
      // Don't log errors from logging to avoid recursion
    }
  }

  /**
   * Get dashboard statistics
   */
  async getDashboardStats(): Promise<any> {
    const query = `
      SELECT 
        (SELECT COUNT(*) FROM trades WHERE status = 'open') as open_trades,
        (SELECT COUNT(*) FROM trades WHERE DATE(executed_at) = CURRENT_DATE) as today_trades,
        (SELECT COALESCE(SUM(pnl), 0) FROM trades WHERE DATE(executed_at) = CURRENT_DATE AND status = 'closed') as today_pnl,
        (SELECT COUNT(*) FROM ai_decisions WHERE created_at >= NOW() - INTERVAL '1 hour') as recent_decisions,
        (SELECT balance FROM account_history ORDER BY timestamp DESC LIMIT 1) as current_balance,
        (SELECT COUNT(*) FROM trades WHERE status = 'closed') as total_closed,
        (SELECT COUNT(*) FROM trades WHERE status = 'closed' AND pnl > 0) as winning_trades
    `;
    const result = await this.pool.query(query);
    const row = result.rows[0];
    
    // Calculate win rate
    const totalClosed = parseInt(row.total_closed) || 0;
    const winningTrades = parseInt(row.winning_trades) || 0;
    const winRate = totalClosed > 0 ? (winningTrades / totalClosed) * 100 : 0;
    
    return {
      ...row,
      win_rate: winRate
    };
  }

  /**
   * Close a specific trade by ID
   */
  async closeTrade(tradeId: string, exitPrice: number, pnl: number): Promise<void> {
    try {
      const query = `
        UPDATE trades 
        SET exit_price = $1, pnl = $2, status = 'closed', closed_at = NOW(), 
            pnl_percentage = CASE WHEN entry_price > 0 THEN (($1 - entry_price) / entry_price * 100) ELSE 0 END
        WHERE trade_id = $3 AND status = 'open'
      `;
      await this.pool.query(query, [exitPrice, pnl, tradeId]);
      logger.info('Trade closed', { tradeId, exitPrice, pnl });
    } catch (error) {
      logger.error('Failed to close trade', error);
      throw error;
    }
  }

  /**
   * Close all open trades
   */
  async closeAllTrades(): Promise<number> {
    try {
      const query = `
        UPDATE trades 
        SET status = 'closed', closed_at = NOW(), pnl = 0, exit_price = entry_price
        WHERE status = 'open'
        RETURNING id
      `;
      const result = await this.pool.query(query);
      const count = result.rowCount || 0;
      logger.info('All trades closed', { count });
      return count;
    } catch (error) {
      logger.error('Failed to close all trades', error);
      throw error;
    }
  }

  /**
   * Reset all data (for testing purposes)
   */
  async resetAll(): Promise<void> {
    try {
      await this.pool.query('TRUNCATE TABLE trades, ai_decisions, market_snapshots, account_history, performance_metrics RESTART IDENTITY CASCADE');
      logger.info('Database reset completed');
    } catch (error) {
      logger.error('Failed to reset database', error);
      throw error;
    }
  }

  /**
   * Get trade statistics for AI context (win rate, average win/loss, etc.)
   */
  async getTradeStats(): Promise<{
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    averageWin: number;
    averageLoss: number;
    profitFactor: number;
    recentWinRate: number;
    consecutiveLosses: number;
  }> {
    try {
      // Get overall stats
      const overallQuery = `
        SELECT 
          COUNT(*) FILTER (WHERE status = 'closed') as total_trades,
          COUNT(*) FILTER (WHERE status = 'closed' AND pnl > 0) as winning_trades,
          COUNT(*) FILTER (WHERE status = 'closed' AND pnl <= 0) as losing_trades,
          COALESCE(AVG(pnl) FILTER (WHERE status = 'closed' AND pnl > 0), 0) as avg_win,
          COALESCE(AVG(ABS(pnl)) FILTER (WHERE status = 'closed' AND pnl < 0), 0) as avg_loss,
          COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND pnl > 0), 0) as total_wins,
          COALESCE(ABS(SUM(pnl) FILTER (WHERE status = 'closed' AND pnl < 0)), 1) as total_losses
        FROM trades
      `;
      const overallResult = await this.pool.query(overallQuery);
      const overall = overallResult.rows[0];

      // Get recent trades stats (last 20 trades)
      const recentQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE pnl > 0) as wins
        FROM (
          SELECT pnl FROM trades 
          WHERE status = 'closed' 
          ORDER BY closed_at DESC 
          LIMIT 20
        ) recent
      `;
      const recentResult = await this.pool.query(recentQuery);
      const recent = recentResult.rows[0];

      // Get consecutive losses
      const consecutiveQuery = `
        WITH ranked_trades AS (
          SELECT pnl, 
                 ROW_NUMBER() OVER (ORDER BY closed_at DESC) as rn
          FROM trades 
          WHERE status = 'closed'
        )
        SELECT COUNT(*) as consecutive_losses
        FROM ranked_trades
        WHERE rn <= (
          SELECT COALESCE(MIN(rn) - 1, 0)
          FROM ranked_trades
          WHERE pnl > 0
        ) OR (SELECT COUNT(*) FROM ranked_trades WHERE pnl > 0) = 0
      `;
      const consecutiveResult = await this.pool.query(consecutiveQuery);
      const consecutive = consecutiveResult.rows[0];

      const totalTrades = parseInt(overall.total_trades) || 0;
      const winningTrades = parseInt(overall.winning_trades) || 0;
      const losingTrades = parseInt(overall.losing_trades) || 0;
      const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
      const averageWin = parseFloat(overall.avg_win) || 0;
      const averageLoss = parseFloat(overall.avg_loss) || 0;
      const profitFactor = parseFloat(overall.total_losses) > 0 
        ? parseFloat(overall.total_wins) / parseFloat(overall.total_losses) 
        : 0;
      const recentTotal = parseInt(recent.total) || 0;
      const recentWins = parseInt(recent.wins) || 0;
      const recentWinRate = recentTotal > 0 ? (recentWins / recentTotal) * 100 : 0;
      const consecutiveLosses = parseInt(consecutive.consecutive_losses) || 0;

      return {
        totalTrades,
        winningTrades,
        losingTrades,
        winRate,
        averageWin,
        averageLoss,
        profitFactor,
        recentWinRate,
        consecutiveLosses,
      };
    } catch (error) {
      logger.error('Failed to get trade stats', error);
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        averageWin: 0,
        averageLoss: 0,
        profitFactor: 0,
        recentWinRate: 0,
        consecutiveLosses: 0,
      };
    }
  }

  /**
   * Get current account balance (persisted)
   * Returns the latest balance from account_history, or STARTING_BALANCE if none exists
   */
  async getCurrentBalance(): Promise<number> {
    try {
      const query = `
        SELECT balance FROM account_history 
        ORDER BY timestamp DESC 
        LIMIT 1
      `;
      const result = await this.pool.query(query);
      
      if (result.rows.length > 0) {
        return parseFloat(result.rows[0].balance) || 0;
      }
      
      // No balance history - initialize with STARTING_BALANCE
      const startingBalance = parseFloat(process.env.STARTING_BALANCE || '100');
      await this.initializeBalance(startingBalance);
      return startingBalance;
    } catch (error) {
      logger.error('Failed to get current balance', error);
      return parseFloat(process.env.STARTING_BALANCE || '100');
    }
  }

  /**
   * Initialize balance for new account
   */
  async initializeBalance(balance: number): Promise<void> {
    try {
      const query = `
        INSERT INTO account_history (balance, available_balance, total_pnl, daily_pnl, open_positions)
        VALUES ($1, $1, 0, 0, 0)
      `;
      await this.pool.query(query, [balance]);
      logger.info('Balance initialized', { balance });
    } catch (error) {
      logger.error('Failed to initialize balance', error);
    }
  }

  /**
   * Update balance after trade close
   * This is the core function that maintains realistic balance tracking
   */
  async updateBalanceOnTradeClose(pnl: number): Promise<number> {
    try {
      // Get current balance
      const currentBalance = await this.getCurrentBalance();
      const newBalance = currentBalance + pnl;
      
      // Get open positions count
      const openPosQuery = `SELECT COUNT(*) as count FROM trades WHERE status = 'open'`;
      const openPosResult = await this.pool.query(openPosQuery);
      const openPositions = parseInt(openPosResult.rows[0]?.count) || 0;
      
      // Get total P&L
      const totalPnlQuery = `SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE status = 'closed'`;
      const totalPnlResult = await this.pool.query(totalPnlQuery);
      const totalPnl = parseFloat(totalPnlResult.rows[0]?.total) || 0;
      
      // Get today's P&L
      const todayPnlQuery = `
        SELECT COALESCE(SUM(pnl), 0) as daily 
        FROM trades 
        WHERE status = 'closed' AND DATE(closed_at) = CURRENT_DATE
      `;
      const todayPnlResult = await this.pool.query(todayPnlQuery);
      const dailyPnl = parseFloat(todayPnlResult.rows[0]?.daily) || 0;
      
      // Insert new balance record
      const insertQuery = `
        INSERT INTO account_history (balance, available_balance, total_pnl, daily_pnl, open_positions)
        VALUES ($1, $1, $2, $3, $4)
      `;
      await this.pool.query(insertQuery, [newBalance, totalPnl, dailyPnl, openPositions]);
      
      logger.info('Balance updated', { 
        previousBalance: currentBalance, 
        pnl, 
        newBalance,
        totalPnl,
        dailyPnl 
      });
      
      return newBalance;
    } catch (error) {
      logger.error('Failed to update balance on trade close', error);
      throw error;
    }
  }

  /**
   * Reserve margin when opening a trade
   * Updates available_balance to reflect margin used
   */
  async reserveMargin(marginRequired: number): Promise<boolean> {
    try {
      const currentBalance = await this.getCurrentBalance();
      
      // Get currently used margin from open positions
      const marginQuery = `
        SELECT COALESCE(SUM(entry_price * quantity / COALESCE(leverage, 1)), 0) as used_margin
        FROM trades 
        WHERE status = 'open'
      `;
      const marginResult = await this.pool.query(marginQuery);
      const usedMargin = parseFloat(marginResult.rows[0]?.used_margin) || 0;
      
      const availableMargin = currentBalance - usedMargin;
      
      if (availableMargin < marginRequired) {
        logger.warn('Insufficient margin', { 
          currentBalance, 
          usedMargin, 
          availableMargin, 
          marginRequired 
        });
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to check margin', error);
      return false;
    }
  }

  /**
   * Get detailed account state (like an exchange would show)
   */
  async getAccountState(): Promise<{
    balance: number;
    equity: number;
    usedMargin: number;
    freeMargin: number;
    marginLevel: number;
    unrealizedPnl: number;
    totalPnl: number;
    dailyPnl: number;
    openPositions: number;
  }> {
    try {
      const balance = await this.getCurrentBalance();
      
      // Get open positions with current P&L
      const posQuery = `
        SELECT 
          COUNT(*) as count,
          COALESCE(SUM(entry_price * quantity / COALESCE(leverage, 1)), 0) as used_margin
        FROM trades 
        WHERE status = 'open'
      `;
      const posResult = await this.pool.query(posQuery);
      const openPositions = parseInt(posResult.rows[0]?.count) || 0;
      const usedMargin = parseFloat(posResult.rows[0]?.used_margin) || 0;
      
      // Get total and daily P&L
      const pnlQuery = `
        SELECT 
          COALESCE(SUM(pnl), 0) as total_pnl,
          COALESCE(SUM(CASE WHEN DATE(closed_at) = CURRENT_DATE THEN pnl ELSE 0 END), 0) as daily_pnl
        FROM trades 
        WHERE status = 'closed'
      `;
      const pnlResult = await this.pool.query(pnlQuery);
      const totalPnl = parseFloat(pnlResult.rows[0]?.total_pnl) || 0;
      const dailyPnl = parseFloat(pnlResult.rows[0]?.daily_pnl) || 0;
      
      // Note: unrealizedPnl needs to be calculated with current prices
      // This is done in the WebSocket update loop
      const unrealizedPnl = 0; // Will be calculated live
      
      const equity = balance + unrealizedPnl;
      const freeMargin = equity - usedMargin;
      const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : 0;
      
      return {
        balance,
        equity,
        usedMargin,
        freeMargin,
        marginLevel,
        unrealizedPnl,
        totalPnl,
        dailyPnl,
        openPositions
      };
    } catch (error) {
      logger.error('Failed to get account state', error);
      return {
        balance: parseFloat(process.env.STARTING_BALANCE || '100'),
        equity: parseFloat(process.env.STARTING_BALANCE || '100'),
        usedMargin: 0,
        freeMargin: parseFloat(process.env.STARTING_BALANCE || '100'),
        marginLevel: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        dailyPnl: 0,
        openPositions: 0
      };
    }
  }

  /**
   * Reset balance to starting amount (for testing/reset)
   */
  async resetBalance(): Promise<void> {
    try {
      // Clear account history
      await this.pool.query('TRUNCATE TABLE account_history RESTART IDENTITY');
      
      // Initialize with starting balance
      const startingBalance = parseFloat(process.env.STARTING_BALANCE || '100');
      await this.initializeBalance(startingBalance);
      
      logger.info('Balance reset to starting amount', { startingBalance });
    } catch (error) {
      logger.error('Failed to reset balance', error);
      throw error;
    }
  }
}

export const dbService = new DatabaseService();
export default dbService;
