import fs from 'fs';
import path from 'path';
import { config } from '../utils/config';

function getLogPath(): string {
  const dir = config.system.logDir || './logs';
  const fileName = `trades-detailed-${new Date().toISOString().slice(0,10)}.jsonl`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

export function logTradeEvent(eventType: string, payload: Record<string, any>): void {
  try {
    const record = { ts: Date.now(), event: eventType, ...payload };
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(getLogPath(), line, { encoding: 'utf8' });
  } catch (err) {
    // Do not throw - logging failure shouldn't break trading
    console.error('Failed to write trade log', err);
  }
}

export default { logTradeEvent };
