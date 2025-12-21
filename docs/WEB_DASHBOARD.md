# 🌐 Web Dashboard - Trading AI Agent

Interfaccia web in tempo reale per monitorare il Trading AI Agent.

## 📋 Caratteristiche

- **Dashboard in Tempo Reale**: Statistiche live con aggiornamenti via WebSocket
- **Gestione Operazioni**: Visualizza tutte le operazioni aperte e chiuse
- **Analisi Performance**: Metriche dettagliate con Win Rate, P&L, Sharpe Ratio
- **Storico Decisioni AI**: Tutte le decisioni prese dall'AI con motivazioni e indicatori
- **Design Responsive**: Interfaccia moderna e user-friendly
- **Database PostgreSQL**: Persistenza dati completa

## 🚀 Avvio Rapido

### 1. Prerequisiti

```bash
# Installa PostgreSQL
sudo apt install postgresql postgresql-contrib  # Ubuntu/Debian
brew install postgresql                          # macOS
```

### 2. Configurazione Database

```bash
# Esegui lo script di setup
chmod +x scripts/setup-database.sh
./scripts/setup-database.sh

# Oppure manualmente:
sudo -u postgres createdb trading_ai_db
sudo -u postgres psql -d trading_ai_db -f src/database/schema.sql
```

### 3. Configura le variabili d'ambiente

Modifica il file `.env`:

```env
# Database PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_ai_db
DB_USER=postgres
DB_PASSWORD=postgres

# Web Dashboard
WEB_PORT=3000
```

### 4. Avvia la Dashboard

```bash
npm run web
```

Apri il browser su: **http://localhost:3000**

## 📊 Struttura Database

### Tabelle Principali

- **trades**: Tutte le operazioni eseguite
- **ai_decisions**: Decisioni prese dall'AI con indicatori tecnici
- **market_snapshots**: Snapshot periodici del mercato
- **account_history**: Storico balance e P&L
- **performance_metrics**: Metriche giornaliere aggregate
- **system_logs**: Log di sistema

### Views

- **v_active_trades**: Operazioni aperte
- **v_recent_decisions**: Ultime decisioni AI
- **v_daily_performance**: Performance giornaliera aggregata

## 🎨 Pagine Disponibili

### 1. Dashboard (`/`)
- Saldo corrente
- Posizioni aperte
- Trade oggi
- P&L giornaliero
- Ultime decisioni AI

### 2. Operazioni (`/trades`)
- Lista completa operazioni
- Filtri per stato (aperte/chiuse)
- Dettagli P&L per trade
- Commissioni

### 3. Performance (`/performance`)
- Totale trade
- Win Rate
- P&L totale
- Max Drawdown
- Sharpe Ratio
- Performance giornaliera (ultimi 30 giorni)

### 4. Decisioni AI (`/decisions`)
- Storico completo decisioni
- Filtri per tipo (BUY/SELL/HOLD)
- Confidenza AI
- Motivazioni dettagliate
- Indicatori tecnici (RSI, MACD, EMA, Bollinger Bands)

## 🔌 API REST

### Endpoints disponibili

```
GET /api/stats           - Statistiche dashboard
GET /api/trades          - Lista operazioni recenti
GET /api/decisions       - Lista decisioni AI recenti
GET /api/performance     - Metriche performance
```

### Esempio richiesta:

```bash
curl http://localhost:3000/api/stats
```

Risposta:
```json
{
  "open_trades": 3,
  "today_trades": 12,
  "today_pnl": 125.50,
  "recent_decisions": 8,
  "current_balance": 10250.00
}
```

## 🔄 WebSocket Events

La dashboard utilizza Socket.io per aggiornamenti in tempo reale:

### Eventi ricevuti dal client:

- `stats:update` - Aggiornamento statistiche (ogni 5 secondi)
- `trade:new` - Nuova operazione eseguita
- `decision:new` - Nuova decisione AI
- `market:update` - Aggiornamento dati mercato

### Esempio di ascolto:

```javascript
const socket = io();

socket.on('trade:new', (trade) => {
  console.log('Nuovo trade:', trade);
});

socket.on('decision:new', (decision) => {
  console.log('Nuova decisione AI:', decision);
});
```

## 🎯 Integrazione con Trading Bot

Il trading bot salva automaticamente i dati nel database:

```typescript
// In tradeLoop.ts
await dbService.saveTrade(order, decision);
await dbService.saveAIDecision(decision, tradeId);
```

## 🛠️ Personalizzazione

### Modifica porta web:

Nel file `.env`:
```env
WEB_PORT=8080
```

### Modifica intervallo aggiornamenti:

In `src/web/server.ts`, nella funzione `setupSocketIO()`:

```typescript
setInterval(async () => {
  const stats = await dbService.getDashboardStats();
  this.io.emit('stats:update', stats);
}, 5000); // Modifica questo valore (in millisecondi)
```

### Personalizza CSS:

Modifica `/public/css/style.css` per cambiare l'aspetto della dashboard.

## 🔍 Troubleshooting

### Errore connessione database:

```bash
# Verifica che PostgreSQL sia in esecuzione
sudo systemctl status postgresql

# Avvia PostgreSQL
sudo systemctl start postgresql

# Test connessione
psql -U postgres -d trading_ai_db -c "SELECT NOW();"
```

### Porta già in uso:

Cambia `WEB_PORT` nel file `.env` con una porta libera.

### Socket.io non si connette:

Verifica che il browser non blocchi le connessioni WebSocket (controlla la console del browser).

## 📈 Performance

- **Caricamento iniziale**: < 500ms
- **Aggiornamenti real-time**: Ogni 5 secondi
- **Query database**: Ottimizzate con indici
- **Connessioni simultanee**: Supporta 20+ client

## 🔒 Sicurezza

⚠️ **IMPORTANTE**: La dashboard è attualmente senza autenticazione.

Per uso in produzione, aggiungi:
- Autenticazione (JWT, OAuth)
- HTTPS
- Rate limiting
- CORS configurato

## 📝 Logs

I log del web server sono salvati insieme ai log del bot:

```bash
tail -f logs/combined.log
tail -f logs/error.log
```

## 🤝 Supporto

Per problemi o domande:
1. Controlla i log: `logs/combined.log`
2. Verifica configurazione database in `.env`
3. Controlla che PostgreSQL sia in esecuzione

## 🎉 Esempi di Utilizzo

### Avvia bot + dashboard insieme:

```bash
# Terminale 1: Avvia il trading bot
npm run trade

# Terminale 2: Avvia la dashboard
npm run web
```

### Solo dashboard (visualizza dati storici):

```bash
npm run web
```

## 📚 Stack Tecnologico

- **Backend**: Node.js + Express.js
- **Template Engine**: EJS
- **Database**: PostgreSQL 14+
- **Real-time**: Socket.io
- **Styling**: Custom CSS (responsive)
- **Charts**: (TODO: Chart.js/D3.js integration)

---

**Realizzato con ❤️ per Trading AI Agent**
