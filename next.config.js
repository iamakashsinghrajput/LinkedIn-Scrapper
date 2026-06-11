/** @type {import('next').NextConfig} */
const nextConfig = {
  // playwright-core spawns a real browser binary — keep it out of the bundle.
  serverExternalPackages: ["playwright-core"],
};

module.exports = nextConfig;
