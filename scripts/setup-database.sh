#!/bin/bash

# Trading AI Agent - Database Setup Script

echo "🗄️  Configurazione Database PostgreSQL per Trading AI Agent"
echo ""

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL non è installato. Installalo prima di continuare:"
    echo "   Ubuntu/Debian: sudo apt install postgresql postgresql-contrib"
    echo "   macOS: brew install postgresql"
    echo "   Windows: Scarica da https://www.postgresql.org/download/"
    exit 1
fi

echo "✅ PostgreSQL trovato"
echo ""

# Configuration
DB_NAME="trading_ai_db"
DB_USER="postgres"
DB_PASSWORD="postgres"

echo "📋 Configurazione Database:"
echo "   Nome Database: $DB_NAME"
echo "   Utente: $DB_USER"
echo ""

# Ask for confirmation
read -p "Vuoi procedere con questa configurazione? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Operazione annullata."
    exit 1
fi

# Create database
echo ""
echo "🔧 Creazione database..."

# Check if database exists
if sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
    echo "⚠️  Database $DB_NAME già esistente."
    read -p "Vuoi ricreare il database? (cancella tutti i dati) (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo -u postgres psql -c "DROP DATABASE $DB_NAME;"
        echo "🗑️  Database eliminato."
    else
        echo "Mantengo il database esistente."
    fi
fi

# Create database if it doesn't exist
if ! sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME;"
    echo "✅ Database $DB_NAME creato."
fi

# Execute schema
echo ""
echo "📝 Applicazione schema..."
sudo -u postgres psql -d $DB_NAME -f src/database/schema.sql

if [ $? -eq 0 ]; then
    echo "✅ Schema applicato con successo!"
else
    echo "❌ Errore nell'applicazione dello schema."
    exit 1
fi

# Set password for postgres user (optional)
echo ""
echo "🔐 Impostazione password per utente postgres..."
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '$DB_PASSWORD';"

echo ""
echo "✅ Configurazione database completata!"
echo ""
echo "📌 Configurazione .env:"
echo "   DB_HOST=localhost"
echo "   DB_PORT=5432"
echo "   DB_NAME=$DB_NAME"
echo "   DB_USER=$DB_USER"
echo "   DB_PASSWORD=$DB_PASSWORD"
echo ""
echo "🚀 Puoi ora avviare la dashboard con: npm run web"
