import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  esbuild: {
    // Tự động xoá toàn bộ console.log, console.warn, debugger khi build production
    // Đảm bảo người dùng mở F12 Console sẽ hoàn toàn sạch sẽ, không lộ bất kỳ thông tin nội bộ nào
    drop: mode === 'production' ? ['console', 'debugger'] : []
  },
  build: {
    // Không sinh source map trong bản production để tránh dịch ngược mã nguồn gốc qua F12
    sourcemap: false
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true
      }
    }
  }
}));
