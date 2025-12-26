
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

console.log('DB Config:', {
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER
});

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'trading_ai_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function resetDb() {
  try {
    console.log('Resetting database...');
    await pool.query('TRUNCATE TABLE trades RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE TABLE account_history RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE TABLE performance_metrics RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE TABLE ai_decisions RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE TABLE system_logs RESTART IDENTITY CASCADE');
    console.log('Database reset successfully.');
  } catch (error) {
    console.error('Error resetting database:', error);
  } finally {
    await pool.end();
  }
}

resetDb();
