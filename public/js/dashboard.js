// Socket.IO connection con reconnect limitato
const socket = io({
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000
});

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

// Track recently closed trades to prevent ghost positions (race condition fix)
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
    
    // Filter out recently closed trades to prevent ghost positions
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

// Listen for WebSocket events
socket.on('trade:closed', (data) => {
    console.log('Trade closed:', data);
    
    // Track this trade as recently closed to prevent ghost positions
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
    
    // Track this trade as recently closed to prevent ghost positions
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
