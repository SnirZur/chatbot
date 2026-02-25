import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('packages', 'server', '.env');

const applyEnv = (content: string) => {
   for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (!key) continue;
      const value = rest.join('=').trim();
      if (!value) continue;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value.replace(/^"|"$/g, '');
   }
};

try {
   if (fs.existsSync(envPath)) {
      applyEnv(fs.readFileSync(envPath, 'utf-8'));
   }
} catch (error) {
   console.warn('Failed to load env file:', error);
}
