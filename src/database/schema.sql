-- Trading AI Agent Database Schema

-- Create database
-- CREATE DATABASE trading_ai_db;

-- Connect to database
-- \c trading_ai_db;

-- Trades table - stores all executed trades
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(100) UNIQUE NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL, -- 'buy' or 'sell'
    order_type VARCHAR(20) NOT NULL, -- 'market', 'limit', 'stop'
    quantity DECIMAL(18, 8) NOT NULL,
    entry_price DECIMAL(18, 8) NOT NULL,
    exit_price DECIMAL(18, 8),
    stop_loss DECIMAL(18, 8),
    take_profit DECIMAL(18, 8),
    status VARCHAR(20) NOT NULL, -- 'open', 'closed', 'cancelled'
    pnl DECIMAL(18, 8),
    pnl_percentage DECIMAL(10, 4),
    fee DECIMAL(18, 8),
    executed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- AI Decisions table - stores all AI recommendations
CREATE TABLE IF NOT EXISTS ai_decisions (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    decision VARCHAR(10) NOT NULL, -- 'BUY', 'SELL', 'HOLD'
    confidence DECIMAL(5, 4) NOT NULL, -- 0.0000 to 1.0000
    reasoning TEXT NOT NULL,
    current_price DECIMAL(18, 8) NOT NULL,
    suggested_price DECIMAL(18, 8),
    suggested_quantity DECIMAL(18, 8),
    stop_loss DECIMAL(18, 8),
    take_profit DECIMAL(18, 8),
    executed BOOLEAN DEFAULT FALSE,
    trade_id VARCHAR(100),
    -- Technical indicators at decision time
    rsi DECIMAL(10, 4),
    macd DECIMAL(18, 8),
    macd_signal DECIMAL(18, 8),
    macd_histogram DECIMAL(18, 8),
    ema_12 DECIMAL(18, 8),
    ema_26 DECIMAL(18, 8),
    bb_upper DECIMAL(18, 8),
    bb_middle DECIMAL(18, 8),
    bb_lower DECIMAL(18, 8),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Market data snapshots
CREATE TABLE IF NOT EXISTS market_snapshots (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    price DECIMAL(18, 8) NOT NULL,
    volume_24h DECIMAL(20, 8),
    price_change_24h DECIMAL(10, 4),
    volatility DECIMAL(10, 4),
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Account balances history
CREATE TABLE IF NOT EXISTS account_history (
    id SERIAL PRIMARY KEY,
    balance DECIMAL(18, 8) NOT NULL,
    available_balance DECIMAL(18, 8) NOT NULL,
    total_pnl DECIMAL(18, 8) NOT NULL,
    daily_pnl DECIMAL(18, 8) NOT NULL,
    open_positions INTEGER NOT NULL DEFAULT 0,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Performance metrics
CREATE TABLE IF NOT EXISTS performance_metrics (
    id SERIAL PRIMARY KEY,
    metric_date DATE NOT NULL UNIQUE,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    win_rate DECIMAL(5, 4),
    total_pnl DECIMAL(18, 8),
    daily_pnl DECIMAL(18, 8),
    max_drawdown DECIMAL(10, 4),
    sharpe_ratio DECIMAL(10, 4),
    avg_trade_duration_minutes INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- System logs
CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(20) NOT NULL, -- 'info', 'warn', 'error', 'debug'
    message TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_executed_at ON trades(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_symbol ON ai_decisions(symbol);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_decision ON ai_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_created_at ON ai_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol ON market_snapshots(symbol);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_timestamp ON market_snapshots(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_account_history_timestamp ON account_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_date ON performance_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at DESC);

-- Create views for quick queries
CREATE OR REPLACE VIEW v_active_trades AS
SELECT * FROM trades WHERE status = 'open' ORDER BY executed_at DESC;

CREATE OR REPLACE VIEW v_recent_decisions AS
SELECT * FROM ai_decisions ORDER BY created_at DESC LIMIT 100;

CREATE OR REPLACE VIEW v_daily_performance AS
SELECT 
    DATE(executed_at) as trade_date,
    COUNT(*) as total_trades,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
    SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
    SUM(pnl) as daily_pnl,
    AVG(pnl) as avg_pnl,
    MAX(pnl) as best_trade,
    MIN(pnl) as worst_trade
FROM trades
WHERE status = 'closed'
GROUP BY DATE(executed_at)
ORDER BY trade_date DESC;

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_performance_metrics_updated_at BEFORE UPDATE ON performance_metrics
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert initial performance metric for today
INSERT INTO performance_metrics (metric_date, total_trades, winning_trades, losing_trades, win_rate, total_pnl, daily_pnl)
VALUES (CURRENT_DATE, 0, 0, 0, 0, 0, 0)
ON CONFLICT (metric_date) DO NOTHING;
