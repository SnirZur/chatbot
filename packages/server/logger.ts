type LogLevel = 'on' | 'off';

const DEBUG_LOGS = (process.env.DEBUG_LOGS || '').toLowerCase() === 'true';
const LOG_LEVEL: LogLevel = DEBUG_LOGS ? 'on' : 'off';

const PREFIX = '[ORCH]';

export function debugEnabled() {
   return LOG_LEVEL === 'on';
}

function truncate(text: string, maxLen = 260): string {
   if (text.length <= maxLen) {
      return text;
   }
   return `${text.slice(0, maxLen)}…`;
}

export function safeJson(obj: unknown, maxLen = 260): string {
   try {
      return truncate(JSON.stringify(obj), maxLen);
   } catch {
      return '[unserializable]';
   }
}

export function logLine(reqId: string, message: string) {
   if (!debugEnabled()) {
      return;
   }
   console.log(`${PREFIX} [${reqId}] ${message}`);
}

export function logPhase(reqId: string, phaseTitle: string) {
   if (!debugEnabled()) {
      return;
   }
   console.log(`${PREFIX} [${reqId}] === ${phaseTitle} ===`);
}

export function logError(reqId: string, message: string) {
   console.error(`${PREFIX} [${reqId}] ERROR ${message}`);
}

export function logBlock(
   reqId: string,
   label: string,
   text: string,
   maxLen = 1200
) {
   if (!debugEnabled()) {
      return;
   }
   const truncated = truncate(text, maxLen);
   const lines = truncated.split('\n');
   for (const line of lines) {
      logLine(reqId, `${label} ${line}`);
   }
}

export function preview(value: unknown, maxLen = 200): string {
   if (value === null || value === undefined) {
      return String(value);
   }
   if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
   }
   if (typeof value === 'string') {
      return truncate(value, maxLen);
   }
   return safeJson(value, maxLen);
}
