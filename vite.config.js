import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      // Keep the browser's Host header: the API rejects POSTs whose Origin doesn't match it.
      "/api": { target: "http://localhost:3001", changeOrigin: false },
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
