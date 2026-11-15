import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The typed client lives in ../blockchain, which has its own node_modules.
  // Without deduping, the bundle holds two algosdk copies and an Address
  // created by one is rejected by the other ("Not an address: ...").
  resolve: { dedupe: ["algosdk", "@algorandfoundation/algokit-utils"] },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        deploy: "deploy.html",
      },
    },
  },
  // The typed contract client is generated into ../blockchain/artifacts, so the
  // dev server has to be allowed to read outside the frontend root.
  server: { fs: { allow: [".."] } },
});
