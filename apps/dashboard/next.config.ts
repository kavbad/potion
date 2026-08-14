import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Step 9: the derived-form package (pure ESM workspace dist).
  transpilePackages: ['@potion/lab-form'],
};

export default nextConfig;
