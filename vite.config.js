import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Rolldown ko bypass karne ke liye experimental/bundler flag
  experimental: {
    // Kuch versions mein rolldown flags ko override karne ke liye build options ka use hota hai
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replace(/\\/g, '/');
          if (moduleId.includes('/node_modules/firebase/') || moduleId.includes('/node_modules/@firebase/')) {
            return 'firebase';
          }
        },
      },
    }
  },
})