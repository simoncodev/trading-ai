#!/bin/bash

# Trading AI Agent - Quick Start Script
# Questo script avvia la dashboard web

echo "🤖 Trading AI Agent - Web Dashboard"
echo "===================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js non trovato. Installa Node.js 18+ prima di continuare."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo ""

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installazione dipendenze..."
    npm install
    echo ""
fi

# Check if project is built
if [ ! -d "dist" ]; then
    echo "🔨 Compilazione progetto..."
    npm run build
    echo ""
fi

# Check PostgreSQL connection
echo "🔍 Verifica connessione PostgreSQL..."
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-trading_ai_db}
DB_USER=${DB_USER:-postgres}

if command -v psql &> /dev/null; then
    if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT 1;" &> /dev/null; then
        echo "✅ Database connesso: $DB_NAME"
    else
        echo "⚠️  Database non raggiungibile. Assicurati che PostgreSQL sia in esecuzione."
        echo "   Esegui: ./scripts/setup-database.sh per configurare il database."
        echo ""
        read -p "Vuoi continuare comunque? (y/n) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
else
    echo "⚠️  psql non trovato. Assicurati che PostgreSQL sia installato."
fi

echo ""
echo "🚀 Avvio Web Dashboard..."
echo ""
echo "   Dashboard sarà disponibile su: http://localhost:${WEB_PORT:-3000}"
echo ""
echo "   Pagine disponibili:"
echo "   - http://localhost:${WEB_PORT:-3000}/          (Dashboard)"
echo "   - http://localhost:${WEB_PORT:-3000}/trades    (Operazioni)"
echo "   - http://localhost:${WEB_PORT:-3000}/performance (Performance)"
echo "   - http://localhost:${WEB_PORT:-3000}/decisions (Decisioni AI)"
echo ""
echo "   Premi Ctrl+C per fermare il server"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Start the web server
npm run web
