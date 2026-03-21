import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
   const env = loadEnv(mode, process.cwd(), '');
   const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';
   return {
      plugins: [react(), tailwindcss()],
      resolve: {
         alias: {
            '@': path.resolve(__dirname, './src'),
         },
      },
      server: {
         port: 5137,
         proxy: {
            '/api': proxyTarget,
         },
      },
   };
});
