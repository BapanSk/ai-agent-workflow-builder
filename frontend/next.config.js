/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    allowedHosts: ['.monkeycode-ai.live'],
  },
};

module.exports = nextConfig;
