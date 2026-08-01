/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pg живёт только в node-рантайме роутов, в клиентский бандл не тянем
  experimental: {
    serverComponentsExternalPackages: ['pg'],
  },
};

export default nextConfig;
