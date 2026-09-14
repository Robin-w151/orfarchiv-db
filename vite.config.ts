import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    ssr: true,
    lib: {
      entry: {
        db: './src/index.ts',
      },
      formats: ['es'],
      name: 'db',
    },
    emptyOutDir: true,
  },
});
