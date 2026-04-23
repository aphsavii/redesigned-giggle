import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.HOST || "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  preview: {
    host: process.env.HOST || "127.0.0.1",
    port: 4173,
  },
});
