import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Escenario 2 (Reverse Proxy): no anunciar el framework en X-Powered-By.
  poweredByHeader: false,
};

export default nextConfig;
