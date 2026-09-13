import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    ssr: true,
    lib: {
      entry: {
        backup: './src/backup.ts',
        restore: './src/restore.ts',
        setup: './src/setup.ts',
      },
      formats: ['es'],
      name: 'db',
    },
    emptyOutDir: true,
  },
});
