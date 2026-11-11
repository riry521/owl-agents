/** @type {import('next').NextConfig} */
const basePath = '/owl';
const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath,
  // Plain <a> links (not next/link) need the basePath spelled out.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

module.exports = nextConfig;
