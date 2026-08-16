import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/hidden-camera-detector/",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
});
