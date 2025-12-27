// SpooferProfiler fully disabled: clean single-file stub
// Exports a no-op `spooferProfiler` so imports remain valid but produce no logs.

const noop = () => { /* disabled */ };

export const spooferProfiler = {
  start(): void { noop(); },
  stop(): void { noop(); },
  processAlerts(_alerts: any[]): void { /* disabled */ },
  getAllProfiles(): any[] { return []; },
  getActiveSpoofers(): any[] { return []; },
  getStats(): Record<string, any> { return {}; },
  getSpooferBasedSignal(): null { return null; }
};

export default spooferProfiler;
