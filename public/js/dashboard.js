// Socket.IO connection con reconnect limitato
const socket = io({
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000
});

// ========================================
// DASHBOARD STATE (kill-switch, cooldown, execution quality)
// ========================================
let dashboardState = null;

let dashboardStateLastUpdate = 0;

async function fetchDashboardState() {
    try {
        const res = await fetch('/api/dashboard/state');
        dashboardState = await res.json();
        dashboardStateLastUpdate = Date.now();
        renderKillSwitchBanner();
        renderKillSwitchPanel();
        renderCooldownPanel();
        renderExecutionQuality();
    } catch (e) {
        console.warn('Failed to fetch dashboard state:', e);
    }
}

// Kill switch warning banner at top of page
function renderKillSwitchBanner() {
    let banner = document.getElementById('killSwitchBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'killSwitchBanner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:12px;text-align:center;font-weight:bold;font-size:16px;display:none;';
        document.body.prepend(banner);
    }
    
    if (!dashboardState || !dashboardState.global) {
        banner.style.display = 'none';
        return;
    }
    
    const g = dashboardState.global;
    if (g.kill_switch_active) {
        banner.style.display = 'block';
        banner.style.background = '#f56565';
        banner.style.color = '#fff';
        banner.innerHTML = `⚠️ KILL SWITCH ACTIVE: ${g.kill_switch_reason || 'Unknown reason'} ⚠️`;
    } else if (g.dry_run) {
        banner.style.display = 'block';
        banner.style.background = '#d69e2e';
        banner.style.color = '#000';
        banner.innerHTML = '🔶 DRY RUN MODE - No real orders will be placed';
    } else if (!g.trading_enabled) {
        banner.style.display = 'block';
        banner.style.background = '#718096';
        banner.style.color = '#fff';
        banner.innerHTML = '⏸️ TRADING DISABLED';
    } else {
        banner.style.display = 'none';
    }
}

function renderKillSwitchPanel() {
    const container = document.getElementById('killSwitchPanel');
    if (!container || !dashboardState) return;
    
    const g = dashboardState.global;
    const active = g.kill_switch_active;
    const reason = g.kill_switch_reason || '-';
    const staleMs = Date.now() - dashboardStateLastUpdate;
    const isStale = staleMs > 5000;
    
    container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid #333;">
            <span style="font-weight:bold;">KILL SWITCH</span>
            <span style="color:${active ? '#f56565' : '#48bb78'};font-weight:bold;">${active ? 'ACTIVE' : 'OFF'}</span>
        </div>
        ${active ? `<div style="padding:8px;color:#f56565;font-size:14px;">Reason: ${reason}</div>` : ''}
        <div style="padding:8px;font-size:12px;color:#888;">
            <div>Trading: <span style="color:${g.trading_enabled ? '#48bb78' : '#f56565'}">${g.trading_enabled ? 'ENABLED' : 'DISABLED'}</span> | DRY RUN: <span style="color:${g.dry_run ? '#d69e2e' : '#48bb78'}">${g.dry_run ? 'YES' : 'NO'}</span></div>
            <div>Daily P&L: <span style="color:${g.daily_pnl >= 0 ? '#48bb78' : '#f56565'}">$${g.daily_pnl.toFixed(2)}</span> / Max Drawdown: ${g.max_daily_drawdown_pct}%</div>
            <div>Consecutive Losses: ${g.consecutive_losses} / ${g.max_consecutive_losses}</div>
            <div>Trades Today: ${g.trades_today} / ${g.max_trades_per_day}</div>
            <div style="margin-top:4px;color:${isStale ? '#f56565' : '#666'}">Last update: ${Math.round(staleMs/1000)}s ago ${isStale ? '⚠️ STALE' : ''}</div>
        </div>
    `;
}

function renderCooldownPanel() {
    const container = document.getElementById('cooldownPanel');
    if (!container || !dashboardState) return;
    
    const symbols = Object.keys(dashboardState.symbols || {});
    if (symbols.length === 0) {
        container.innerHTML = '<div class="empty-state">No symbols configured</div>';
        return;
    }
    
    container.innerHTML = symbols.map(sym => {
        const s = dashboardState.symbols[sym];
        const state = s.state || 'IDLE';
        const cooldown = s.cooldown_remaining_ms;
        const cooldownSec = cooldown ? Math.ceil(cooldown / 1000) : 0;
        const stateColor = state === 'OPEN' ? '#48bb78' : (state === 'COOLDOWN' ? '#d69e2e' : (state === 'ENTERING' || state === 'EXITING' ? '#58a6ff' : '#888'));
        
        // State since time
        let stateSince = '';
        if (s.state_since_ts) {
            const ageSec = Math.round((Date.now() - s.state_since_ts) / 1000);
            stateSince = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec/60)}m`;
        }
        
        let details = '';
        if (s.open_position) {
            const op = s.open_position;
            const pnlColor = op.unrealized_pnl >= 0 ? '#48bb78' : '#f56565';
            details = `${op.side} ${op.size}@$${op.entry_px.toFixed(2)} <span style="color:${pnlColor}">P&L: $${op.unrealized_pnl.toFixed(2)}</span>`;
        } else if (cooldownSec > 0) {
            details = `<span style="color:#d69e2e">⏳ ${cooldownSec}s remaining</span>`;
        }
        
        // Maker-first metrics
        const spreadBps = s.spread_bps !== null ? s.spread_bps.toFixed(1) : '-';
        const netEdge = s.net_edge_bps !== null ? s.net_edge_bps.toFixed(1) : '-';
        const execMode = s.exec_mode || 'maker';
        const reason = s.last_reason || '-';
        const activeOrder = s.active_order;
        
        let metricsLine = `<span style="font-size:10px;color:#888;">Spread: ${spreadBps}bps | Edge: ${netEdge}bps | ${execMode.toUpperCase()} | ${reason}</span>`;
        if (activeOrder) {
            metricsLine += ` <span style="color:#58a6ff;">[${activeOrder.intent} ${activeOrder.side} @${activeOrder.requested_px} ${Math.round(activeOrder.age_ms)}ms]</span>`;
        }
        
        return `
            <div style="display:flex;flex-direction:column;padding:6px 8px;border-bottom:1px solid #222;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-weight:bold;color:#ff0;min-width:60px;">${sym.replace('-USDC', '')}</span>
                    <span style="color:${stateColor};min-width:80px;">${state} ${stateSince ? `(${stateSince})` : ''}</span>
                    <span style="color:#aaa;font-size:12px;flex:1;text-align:right;">${details}</span>
                </div>
                <div style="margin-top:2px;">${metricsLine}</div>
            </div>
        `;
    }).join('');
}

function renderExecutionQuality() {
    const container = document.getElementById('executionQuality');
    if (!container || !dashboardState) return;
    
    const execs = dashboardState.recent_executions || [];
    if (execs.length === 0) {
        container.innerHTML = '<div class="empty-state">No executions yet</div>';
        return;
    }
    
    // Calculate average slippage and maker/taker ratio
    const avgSlippage = execs.reduce((sum, e) => sum + (e.slippage_bps || 0), 0) / execs.length;
    const makerCount = execs.filter(e => e.maker_taker && e.maker_taker.toUpperCase().includes('MAKER')).length;
    const makerPct = execs.length > 0 ? ((makerCount / execs.length) * 100).toFixed(0) : 0;
    
    container.innerHTML = `
        <div style="padding:8px;border-bottom:1px solid #333;display:flex;justify-content:space-between;gap:12px;">
            <span>Avg Slippage: <span style="color:${avgSlippage > 10 ? '#f56565' : '#48bb78'};font-weight:bold;">${avgSlippage.toFixed(2)}bps</span></span>
            <span>Maker Rate: <span style="color:${makerPct >= 50 ? '#48bb78' : '#d69e2e'};font-weight:bold;">${makerPct}%</span></span>
        </div>
        <div style="overflow-x:auto;">
        <table style="width:100%;font-size:11px;border-collapse:collapse;">
            <thead>
                <tr style="background:#111;color:#888;">
                    <th style="padding:4px;text-align:left;">Time</th>
                    <th style="padding:4px;text-align:left;">Sym</th>
                    <th style="padding:4px;text-align:left;">Side</th>
                    <th style="padding:4px;text-align:right;">Size</th>
                    <th style="padding:4px;text-align:right;">Fill</th>
                    <th style="padding:4px;text-align:right;">Slip</th>
                    <th style="padding:4px;text-align:center;">M/T</th>
                </tr>
            </thead>
            <tbody>
            ${execs.slice(0, 15).map(e => {
                const time = e.ts ? new Date(e.ts).toLocaleTimeString('it-IT') : '-';
                const slipColor = (e.slippage_bps || 0) > 10 ? '#f56565' : '#48bb78';
                const mt = e.maker_taker ? e.maker_taker.toUpperCase().substring(0,3) : '-';
                const mtColor = mt === 'MAK' ? '#48bb78' : (mt === 'TAK' ? '#f56565' : '#888');
                return `
                <tr style="border-bottom:1px solid #222;">
                    <td style="padding:3px;color:#666;">${time}</td>
                    <td style="padding:3px;color:#ff0;">${(e.symbol || '').replace('-USDC', '')}</td>
                    <td style="padding:3px;color:${e.side === 'BUY' || e.side === 'buy' ? '#48bb78' : '#f56565'};">${(e.side || '-').toUpperCase()}</td>
                    <td style="padding:3px;text-align:right;">${e.size || '-'}</td>
                    <td style="padding:3px;text-align:right;">$${(e.fill_px_avg || 0).toFixed(2)}</td>
                    <td style="padding:3px;text-align:right;color:${slipColor};">${(e.slippage_bps || 0).toFixed(1)}</td>
                    <td style="padding:3px;text-align:center;color:${mtColor};font-weight:bold;">${mt}</td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>
        </div>
    `;
}

// Fetch dashboard state on load and periodically
fetchDashboardState();
setInterval(fetchDashboardState, 5000);

// ========================================
// END DASHBOARD STATE
// ========================================

// Global loadTrades function - reloads recent trades from API
async function loadTrades() {
    try {
        const res = await fetch('/api/trades/recent?limit=5');
        const trades = await res.json();
        renderTrades(trades);
    } catch (e) {
        console.error('Failed to load trades:', e);
    }
}

// Render trades to the UI
function renderTrades(trades) {
    const container = document.getElementById('trades');
    if (!container) return;

    if (!trades || trades.length === 0) {
        container.innerHTML = '<div class="empty-state">NO TRADES YET</div>';
        return;
    }

    container.innerHTML = trades.slice(0, 5).map(t => {
        const pnl = parseFloat(t.pnl) || 0;
        const resultClass = pnl >= 0 ? 'win' : 'loss';
        const symbol = t.symbol.replace('-USDC', '');

        return `
            <div class="trade-row">
                <span class="trade-symbol">${symbol}</span>
                <span class="trade-result ${resultClass}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>
            </div>
        `;
    }).join('');
}

// Close all positions
async function closeAll() {
    if (!confirm('CLOSE ALL POSITIONS?')) return;

    try {
        const res = await fetch('/api/trades/close-all', { method: 'POST' });
        const data = await res.json();
        console.log('Closed positions:', data);
        if (typeof addLog === 'function') {
            addLog('SYSTEM', `Closed ${data.closedCount} positions`, 'sell');
        }
    } catch (e) {
        console.error('Failed to close positions:', e);
        if (typeof addLog === 'function') {
            addLog('SYSTEM', 'Failed to close positions', 'sell');
        }
    }
}

// Reset ALL - balance, trades, decisions
async function resetBalance() {
    if (!confirm('RESET TUTTO? (Balance, Trades, Decisions)')) return;

    try {
        const res = await fetch('/api/reset', { method: 'POST' });
        const data = await res.json();
        console.log('Reset completed:', data);
        if (typeof addLog === 'function') {
            addLog('SYSTEM', 'Reset completo effettuato', 'buy');
        }
        document.getElementById('balance').textContent = '$100.00';
        document.getElementById('winrate').textContent = '0%';
        document.getElementById('pnl').textContent = '$0.00';
        document.getElementById('posCount').textContent = '0';
        document.getElementById('positions').innerHTML = '<div class="empty-state">NO OPEN POSITIONS</div>';
        document.getElementById('trades').innerHTML = '<div class="empty-state">NO TRADES YET</div>';
    } catch (e) {
        console.error('Failed to reset:', e);
        if (typeof addLog === 'function') {
            addLog('SYSTEM', 'Failed to reset', 'sell');
        }
    }
}

// Debug connessione
socket.on('connect', () => {
    console.log('✅ WebSocket connesso:', socket.id);
    updateTimestamp();
    // Reload trades on reconnect
    loadTrades();
});

socket.on('disconnect', (reason) => {
    console.log('❌ WebSocket disconnesso:', reason);
});

socket.on('connect_error', (error) => {
    console.log('⚠️ Errore connessione WebSocket:', error.message);
});

// Pausa aggiornamenti quando tab non visibile
let isPageVisible = true;
document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;
    if (isPageVisible) {
        updateTimestamp();
        loadTrades(); // Reload trades when tab becomes visible
    }
});

// Update timestamp
function updateTimestamp() {
    const el = document.getElementById('lastUpdate');
    if (el) el.textContent = new Date().toLocaleString('it-IT');
}

updateTimestamp();

// Fetch global stats for DRY_RUN / trading enabled banner
async function updateModeStatus() {
    try {
        const res = await fetch('/api/stats');
        const stats = await res.json();
        const el = document.getElementById('dryRunBanner');
        if (el) {
            let text = stats.dry_run ? 'DRY_RUN (no orders)' : (stats.trading_enabled ? 'LIVE' : 'PAUSED');
            el.textContent = text;
            el.style.color = stats.dry_run ? '#d69e2e' : (stats.trading_enabled ? '#48bb78' : '#f56565');
        }
    } catch (e) {
        console.warn('Failed to fetch stats for mode', e);
    }
}

updateModeStatus();
setInterval(updateModeStatus, 5000);

// --- Regime charts (compression & volume) -----------------
let compressionChart = null;
let volumeChart = null;
let activeSymbolForCharts = null;

async function initRegimeCharts() {
    try {
        // Get configured symbols
        const sres = await fetch('/api/symbols');
        const sj = await sres.json();
        const symbols = sj.symbols || [];
        activeSymbolForCharts = symbols[0] || 'BTC-USDC';
        await fetchAndRenderHistory(activeSymbolForCharts);
        
        // Periodically refresh charts from API (every 60s) instead of real-time WS updates
        // This ensures consistent metrics (volume-based compression)
        setInterval(() => {
            if (isPageVisible && activeSymbolForCharts) {
                fetchAndRenderHistory(activeSymbolForCharts);
            }
        }, 60000);
    } catch (e) {
        console.warn('Failed to init regime charts', e);
    }
}

function pushPointToChart(chart, ts, value) {
    const label = new Date(ts).toLocaleTimeString();
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);
    // keep length reasonable
    if (chart.data.labels.length > 120) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(d => d.data.shift());
    }
    chart.update();
}

async function fetchAndRenderHistory(symbol) {
    try {
        const res = await fetch(`/api/signals/history/${encodeURIComponent(symbol)}?minutes=120`);
        const json = await res.json();
        const labels = (json.times || []).map(t => new Date(t).toLocaleTimeString());

        // Compression chart
        const compData = (json.compression || []).map(v => v);
        const ctxC = document.getElementById('chartCompression');
        if (ctxC) {
            if (compressionChart) compressionChart.destroy();
            compressionChart = new Chart(ctxC.getContext('2d'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [{ label: 'Compression (5m/30m)', data: compData, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)', fill: true, tension: 0.2 }]
                },
                options: { animation: false, responsive: true, scales: { y: { beginAtZero: true } } }
            });
        }

        // Volume chart
        const volData = (json.vol1 || []).map(v => v);
        const ctxV = document.getElementById('chartVolume');
        if (ctxV) {
            if (volumeChart) volumeChart.destroy();
            volumeChart = new Chart(ctxV.getContext('2d'), {
                type: 'bar',
                data: { labels, datasets: [{ label: 'Volume 1m', data: volData, backgroundColor: 'rgba(99,102,241,0.6)' }] },
                options: { animation: false, responsive: true, scales: { y: { beginAtZero: true } } }
            });
        }
    } catch (e) {
        console.warn('Failed to fetch regime history', e);
    }
}

// Initialize charts after a short delay (allow DOM)
setTimeout(() => initRegimeCharts(), 500);

// ---------------------------------------------------------

// Listen for real-time updates
socket.on('stats:update', (stats) => {
    if (!isPageVisible) return;
    
    console.log('📊 Stats update ricevuto');
    
    const balanceEl = document.getElementById('currentBalance');
    if (balanceEl) balanceEl.textContent = stats.current_balance ? '$' + parseFloat(stats.current_balance).toFixed(2) : 'N/A';
    
    const openTradesEl = document.getElementById('openTrades');
    if (openTradesEl) openTradesEl.textContent = stats.open_trades || 0;
    
    const todayTradesEl = document.getElementById('todayTrades');
    if (todayTradesEl) todayTradesEl.textContent = stats.today_trades || 0;
    
    const todayPnlElem = document.getElementById('todayPnl');
    if (todayPnlElem) {
        const pnl = stats.today_pnl || 0;
        todayPnlElem.textContent = (pnl >= 0 ? '+' : '') + '$' + parseFloat(pnl).toFixed(2);
    }
    
    updateTimestamp();
});

// Listen for new trades
socket.on('trade:new', (trade) => {
    console.log('Nuova posizione aperta:', trade);
    // Il WebSocket positions:update aggiornerà automaticamente la tabella
});

// Listen for new decisions
socket.on('decision:new', (decision) => {
    console.log('New AI decision:', decision);
    // Handled by decisions:update
});

// Listen for decisions updates (real-time) - con throttle
let lastDecisionsHtml = '';
socket.on('decisions:update', (decisions) => {
    const decisionsContainer = document.getElementById('recentDecisions');
    if (!decisionsContainer || !decisions || decisions.length === 0) return;
    
    const newHtml = decisions.map(decision => {
        const badgeClass = decision.decision === 'BUY' ? 'badge-success' : 
                          decision.decision === 'SELL' ? 'badge-danger' : 'badge-warning';
        const confidence = parseFloat(decision.confidence) * 100;
        const price = parseFloat(decision.current_price);
        const rsi = decision.rsi ? parseFloat(decision.rsi).toFixed(2) : 'N/A';
        const macd = decision.macd ? parseFloat(decision.macd).toFixed(4) : 'N/A';
        const time = new Date(decision.created_at).toLocaleString('it-IT');
        
        return `
            <div class="decision-card">
                <div class="decision-header">
                    <span class="decision-symbol">${decision.symbol}</span>
                    <span class="badge ${badgeClass}">${decision.decision}</span>
                    <span class="decision-confidence">Confidenza: ${confidence.toFixed(1)}%</span>
                </div>
                <p class="decision-reasoning">${decision.reasoning || 'N/A'}</p>
                <div class="decision-indicators">
                    <span>RSI: ${rsi}</span>
                    <span>MACD: ${macd}</span>
                    <span>Prezzo: $${price.toFixed(2)}</span>
                </div>
                <p class="decision-time">${time}</p>
            </div>
        `;
    }).join('');
    
    // Solo aggiorna se il contenuto è cambiato
    if (newHtml !== lastDecisionsHtml) {
        lastDecisionsHtml = newHtml;
        decisionsContainer.innerHTML = newHtml;
    }
    
    updateTimestamp();
});

// Listen for positions updates with live P&L - con throttle
let pendingPositionsData = null;
let positionsUpdateScheduled = false;

// Track recently closed trades to prevent stale position display (race condition fix)
const recentlyClosedTrades = new Map(); // tradeId -> timestamp

function cleanupRecentlyClosedTrades() {
    const now = Date.now();
    for (const [tradeId, timestamp] of recentlyClosedTrades.entries()) {
        if (now - timestamp > 10000) { // Remove after 10 seconds
            recentlyClosedTrades.delete(tradeId);
        }
    }
}

function renderPositions(data) {
    if (!isPageVisible) return; // Skip se tab non visibile
    
    const tbody = document.getElementById('activeTradesBody');
    if (!tbody) return;
    
    // Aggiorna informazioni account (Balance, Equity, Margin)
    if (data.balance !== undefined) {
        const balanceEl = document.getElementById('accountBalance');
        if (balanceEl) balanceEl.textContent = '$' + data.balance.toFixed(2);
    }
    if (data.equity !== undefined) {
        const equityEl = document.getElementById('accountEquity');
        if (equityEl) {
            equityEl.textContent = '$' + data.equity.toFixed(2);
            equityEl.style.color = data.equity >= data.balance ? '#48bb78' : '#f56565';
        }
    }
    if (data.margin !== undefined) {
        const marginEl = document.getElementById('accountMargin');
        if (marginEl) marginEl.textContent = '$' + data.margin.toFixed(2);
    }
    if (data.freeMargin !== undefined) {
        const freeMarginEl = document.getElementById('accountFreeMargin');
        if (freeMarginEl) {
            freeMarginEl.textContent = '$' + data.freeMargin.toFixed(2);
            freeMarginEl.style.color = data.freeMargin > 0 ? '#38b2ac' : '#f56565';
        }
    }
    if (data.marginLevel !== undefined) {
        const marginLevelEl = document.getElementById('accountMarginLevel');
        if (marginLevelEl) {
            marginLevelEl.textContent = data.marginLevel.toFixed(0) + '%';
            marginLevelEl.style.color = data.marginLevel > 200 ? '#48bb78' : data.marginLevel > 100 ? '#ed8936' : '#f56565';
        }
    }
    
    // Clean up old entries from recentlyClosedTrades
    cleanupRecentlyClosedTrades();
    
    // Filter out recently closed trades to prevent stale display
    let positions = data.trades || [];
    positions = positions.filter(trade => !recentlyClosedTrades.has(trade.trade_id));
    
    if (!positions || positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;">Nessuna posizione aperta</td></tr>';
        return;
    }
    
    tbody.innerHTML = positions.map(trade => {
        const pnl = trade.unrealized_pnl || 0;
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlPercentage = trade.pnl_percentage || 0;
        
        const leverageValue = trade.leverage ? parseFloat(trade.leverage) : null;
        const leverageDisplay = leverageValue ? leverageValue.toFixed(0) + 'x' : 'N/A';
        
        return `
            <tr data-trade-id="${trade.trade_id}">
                <td><strong>${trade.symbol}</strong></td>
                <td>
                    <span class="badge ${trade.side === 'buy' ? 'badge-success' : 'badge-danger'}">
                        ${trade.side.toUpperCase()}
                    </span>
                </td>
                <td>${parseFloat(trade.quantity).toFixed(4)}</td>
                <td><strong>${leverageDisplay}</strong></td>
                <td>$${parseFloat(trade.entry_price).toFixed(2)}</td>
                <td>$${(trade.current_price || 0).toFixed(2)}</td>
                <td class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercentage.toFixed(2)}%)</td>
                <td>${trade.stop_loss ? '$' + parseFloat(trade.stop_loss).toFixed(2) : 'N/A'}</td>
                <td>${trade.take_profit ? '$' + parseFloat(trade.take_profit).toFixed(2) : 'N/A'}</td>
                <td>${new Date(trade.executed_at).toLocaleString('it-IT')}</td>
                <td>
                    <button class="btn btn-sm btn-danger" onclick="closePosition('${trade.trade_id}')" title="Chiudi posizione">
                        ❌ Chiudi
                    </button>
                </td>
            </tr>
        `;
    }).join('');
    
    updateTimestamp();
}

socket.on('positions:update', (data) => {
    if (!isPageVisible) return;
    
    console.log('📈 Positions update ricevuto', data.trades?.length || 0, 'posizioni');
    
    pendingPositionsData = data;
    
    // Usa requestAnimationFrame per evitare jank
    if (!positionsUpdateScheduled) {
        positionsUpdateScheduled = true;
        requestAnimationFrame(() => {
            positionsUpdateScheduled = false;
            if (pendingPositionsData) {
                renderPositions(pendingPositionsData);
                pendingPositionsData = null;
            }
        });
    }
});

// Close a single position
async function closePosition(tradeId) {
    if (!confirm('Sei sicuro di voler chiudere questa posizione?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/trades/${tradeId}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert(`Posizione chiusa!\nP&L: $${result.pnl.toFixed(2)}`);
            location.reload();
        } else {
            alert('Errore: ' + (result.error || 'Impossibile chiudere la posizione'));
        }
    } catch (error) {
        console.error('Error closing position:', error);
        alert('Errore di connessione');
    }
}

// Close all positions
async function closeAllPositions() {
    if (!confirm('⚠️ Sei sicuro di voler chiudere TUTTE le posizioni aperte?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/trades/close-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert(`${result.closedCount} posizioni chiuse!`);
            location.reload();
        } else {
            alert('Errore: ' + (result.error || 'Impossibile chiudere le posizioni'));
        }
    } catch (error) {
        console.error('Error closing all positions:', error);
        alert('Errore di connessione');
    }
}

// Reset system (for testing)
async function resetSystem() {
    if (!confirm('⚠️ ATTENZIONE: Questo cancellerà TUTTI i dati (posizioni, trade, decisioni).\n\nSei sicuro di voler resettare il sistema?')) {
        return;
    }
    
    if (!confirm('🚨 CONFERMA FINALE: Tutti i dati verranno eliminati. Procedere?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('✅ Sistema resettato!\nBalance: $100.00');
            location.reload();
        } else {
            alert('Errore: ' + (result.error || 'Impossibile resettare il sistema'));
        }
    } catch (error) {
        console.error('Error resetting system:', error);
        alert('Errore di connessione');
    }
}

// -------------------------
// Regime / Edge UI helpers
// -------------------------

// Track skip reasons for "Why no trades?" summary
const skipReasonCounts = {};
let lastDataTs = Date.now();

function updateSkipReasonCounts(reason) {
    if (!reason || reason === 'EVALUATING') return;
    skipReasonCounts[reason] = (skipReasonCounts[reason] || 0) + 1;
    renderWhyNoTrades();
}

function renderWhyNoTrades() {
    const container = document.getElementById('whyNoTrades');
    if (!container) return;
    const keys = Object.keys(skipReasonCounts);
    if (keys.length === 0) {
        container.innerHTML = '<div class="empty-state">No evaluations yet</div>';
        return;
    }
    // Sort by count descending
    keys.sort((a, b) => skipReasonCounts[b] - skipReasonCounts[a]);
    container.innerHTML = keys.map(k => {
        const count = skipReasonCounts[k];
        const cls = k === 'PASS' ? 'positive' : 'negative';
        return `<div style="display:flex;justify-content:space-between;padding:4px 8px;border-bottom:1px solid #222;"><span class="${cls}">${k}</span><span>${count}</span></div>`;
    }).join('');
}

// Staleness indicator
function updateStalenessIndicator() {
    const el = document.getElementById('stalenessIndicator');
    if (!el) return;
    const age = Math.round((Date.now() - lastDataTs) / 1000);
    const dataStaleMs = 5000; // default, could read from config API
    if (age * 1000 > dataStaleMs) {
        el.textContent = `⚠️ Data stale: ${age}s ago`;
        el.style.color = '#f56565';
    } else {
        el.textContent = `Updated ${age}s ago`;
        el.style.color = '#888';
    }
}
setInterval(updateStalenessIndicator, 1000);

async function fetchAndRenderSignals() {
    try {
        const res = await fetch('/api/signals');
        const data = await res.json();
        for (const symbol in data) {
            const payload = data[symbol];
            if (!payload || !payload.signal) continue;
            renderRegimeForSymbol(symbol, payload.signal, payload.edge);
        }
    } catch (e) {
        console.warn('Failed to fetch signals:', e);
    }
}

function renderRegimeForSymbol(symbol, sig, edge) {
    // Find tile by symbol (support replace of -USDC)
    const idBase = `regime-${symbol.replace(/[^a-zA-Z0-9]/g,'')}`;

    // Create container if missing
    let container = document.getElementById(idBase);
    if (!container) {
        const list = document.getElementById('regimeList');
        if (!list) return;
        container = document.createElement('div');
        container.id = idBase;
        container.className = 'card-body';
        list.appendChild(container);
    }

    const compression = sig.compression ? 'YES' : 'NO';
    const volSpike = sig.volumeSpike || sig.volume_spike ? 'YES' : 'NO';
    const breakout = (sig.breakout && sig.breakout.up) ? 'LONG' : (sig.breakout && sig.breakout.down) ? 'SHORT' : (sig.breakout_direction || 'NONE');
    const expected = edge ? Number(edge.expected_move_bps).toFixed(2) : 'N/A';
    const cost = edge ? Number(edge.cost_bps_total).toFixed(2) : 'N/A';
    const net = edge ? Number(edge.net_edge_bps).toFixed(2) : 'N/A';
    const pass = edge ? (edge.pass ? 'PASS' : 'FAIL') : 'N/A';

    container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div><strong>${symbol}</strong></div>
            <div style="text-align:right">Regime: <span style="font-weight:700">${compression}</span> • VolSpike: <span style="font-weight:700">${volSpike}</span></div>
        </div>
        <div style="margin-top:8px">Breakout: <strong>${breakout}</strong></div>
        <div style="margin-top:8px;display:flex;gap:12px;">
            <div>ExpectedMove: <strong>${expected} bps</strong></div>
            <div>Cost: <strong>${cost} bps</strong></div>
            <div>Net: <strong>${net} bps</strong></div>
            <div>Gate: <strong>${pass}</strong></div>
        </div>
    `;
}

// Listen for regime signal websocket events (emit from server)
socket.on('signal:update', (signal) => {
    try {
        // If server sends a full object with edge, render directly
        if (signal && signal.symbol && signal.edge) {
            renderRegimeForSymbol(signal.symbol, signal.signal || signal, signal.edge);
            return;
        }
        // Otherwise if signal is simplified, fetch aggregate /api/signals
        fetchAndRenderSignals();
    } catch (e) {
        console.warn('signal:update handling error', e);
    }
});

// Also listen for trade executions to update execution table
socket.on('trade:execution', (exec) => {
    // Render a brief execution row into recent executions panel
    const table = document.getElementById('recentExecutions');
    if (!table) return;
    const row = document.createElement('div');
    row.className = 'list-item';
    const px = (exec.fill_px_avg || exec.fillPx || exec.fillPrice || 0).toFixed ? (exec.fill_px_avg || exec.fillPx || exec.fillPrice).toFixed(2) : exec.fill_px_avg;
    row.innerHTML = `<div><strong>${exec.symbol}</strong> ${exec.side.toUpperCase()} ${exec.filled_size || exec.filledSize || exec.size || ''} @ $${px}</div>`;
    table.prepend(row);
    // Keep list to last 50
    while (table.children.length > 50) table.removeChild(table.lastChild);
});

// New: execution reports (per-order / per-fill)
socket.on('execution:report', (exec) => {
    try {
        const container = document.getElementById('recentExecutions');
        if (!container) return;
        const row = document.createElement('div');
        row.className = 'list-item';
        const px = (exec.fill_px_avg || exec.fillPx || exec.fillPrice || 0);
        row.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">` +
            `<div><strong>${exec.symbol}</strong> ${exec.side ? exec.side.toUpperCase() : ''} ${exec.filled_size || exec.filledSize || exec.size || ''}</div>` +
            `<div style="color:#aaa">${px ? ('$' + parseFloat(px).toFixed(2)) : ''}</div>` +
            `</div>`;
        container.prepend(row);
        // keep last 100
        while (container.children.length > 100) container.removeChild(container.lastChild);
    } catch (e) { console.warn('exec report render failed', e); }
});

// New: gate evaluation updates
socket.on('gate:evaluation', (gate) => {
    try {
        lastDataTs = Date.now();
        const container = document.getElementById('gateEvaluations');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'log-entry';
        const pass = gate.pass ? 'PASS' : 'FAIL';
        el.innerHTML = `<strong>${gate.symbol || 'N/A'}</strong> — ${pass} • NetEdge: ${gate.net_edge_bps?.toFixed ? gate.net_edge_bps.toFixed(2) : gate.net_edge_bps} bps<br><small>${new Date(gate.ts).toLocaleTimeString()}</small>`;
        container.prepend(el);
        // keep reasonable length
        while (container.children.length > 50) container.removeChild(container.lastChild);
    } catch (e) { console.warn('gate render failed', e); }
});

// New: decision:update for skip reason tracking
socket.on('decision:update', (decision) => {
    try {
        lastDataTs = Date.now();
        if (decision && decision.reason) {
            updateSkipReasonCounts(decision.reason);
        }
        // Also render regime info if available
        if (decision && decision.symbol) {
            renderRegimeForSymbol(decision.symbol, decision, { 
                expected_move_bps: decision.expectedMoveBps, 
                cost_bps_total: decision.costBps, 
                net_edge_bps: decision.netEdgeBps, 
                pass: decision.reason === 'PASS' 
            });
        }
    } catch (e) { console.warn('decision:update handler failed', e); }
});

// New: lifecycle updates per symbol
const lifecycleState = {};
socket.on('lifecycle:update', (payload) => {
    try {
        const { symbol, lifecycle } = payload;
        if (!symbol) return;
        lifecycleState[symbol] = lifecycle;
        renderLifecycleList();
    } catch (e) { console.warn('lifecycle event handling failed', e); }
});

function renderLifecycleList() {
    const container = document.getElementById('lifecycleList');
    if (!container) return;
    const keys = Object.keys(lifecycleState);
    if (keys.length === 0) {
        container.innerHTML = '<div class="empty-state">No lifecycle events</div>';
        return;
    }
    container.innerHTML = keys.map(sym => {
        const lc = lifecycleState[sym];
        const state = lc.state || 'IDLE';
        const since = lc.state_since_ts ? new Date(lc.state_since_ts).toLocaleTimeString() : '-';
        const op = lc.open_position;
        const details = op ? `${op.side.toUpperCase()} ${op.size}@$${op.entry_px.toFixed(2)}` : '';
        return `<div style="min-width:220px;border:1px solid #333;padding:8px;margin:4px;background:#050505"><strong>${sym}</strong><div style="font-size:12px;color:#aaa">State: ${state} • since ${since}</div><div style="margin-top:6px;color:#fff">${details}</div></div>`;
    }).join('');
}

// Initial load of recent executions via API
async function loadRecentExecutions() {
    try {
        const res = await fetch('/api/executions/recent?limit=50');
        const rows = await res.json();
        const container = document.getElementById('recentExecutions');
        if (!container) return;
        if (!rows || rows.length === 0) {
            container.innerHTML = '<div class="empty-state">No executions yet</div>';
            return;
        }
        container.innerHTML = rows.map(r => `<div class="list-item"><strong>${r.symbol}</strong> ${r.side} ${r.filled_size || r.filledSize || ''} @ $${parseFloat(r.fill_px_avg || r.fillPxAvg || 0).toFixed(2)} <small style="color:#888">${new Date(r.created_at).toLocaleTimeString()}</small></div>`).join('');
    } catch (e) { console.warn('Failed to load recent executions', e); }
}

// Load initial executions
setTimeout(loadRecentExecutions, 500);

// Initial fetch and periodic polling as fallback
fetchAndRenderSignals();
setInterval(fetchAndRenderSignals, 2000);

// Listen for WebSocket events
socket.on('trade:closed', (data) => {
    console.log('Trade closed:', data);
    
    // Track this trade as recently closed to prevent stale display
    if (data.tradeId) {
        recentlyClosedTrades.set(data.tradeId, Date.now());
    }
    
    // Reload trades list
    if (typeof loadTrades === 'function') {
        loadTrades();
    }
});

// Listen for automatic position closures (by Position Manager)
socket.on('position:closed', (data) => {
    console.log('🔒 Position automatically closed:', data);
    
    // Track this trade as recently closed to prevent stale display
    if (data.tradeId) {
        recentlyClosedTrades.set(data.tradeId, Date.now());
    }
    
    // Reload trades list
    if (typeof loadTrades === 'function') {
        loadTrades();
    }
    
    // Show notification
    const notification = document.createElement('div');
    notification.className = 'notification-toast';
    notification.innerHTML = `
        <strong>🔒 Posizione Chiusa Automaticamente</strong><br>
        <span>${data.symbol} ${data.side.toUpperCase()}</span><br>
        <span>P&L: ${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(4)}</span><br>
        <small>${data.reason}</small>
    `;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${data.pnl >= 0 ? '#48bb78' : '#f56565'};
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        z-index: 9999;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 5 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
});

socket.on('trades:allClosed', (data) => {
    console.log('All trades closed:', data);
});

socket.on('system:reset', () => {
    console.log('System reset');
    location.reload();
});

console.log('Dashboard initialized');
