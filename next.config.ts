import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["bullmq", "ioredis", "postgres", "pino", "nodemailer"],
  poweredByHeader: false,
};

export default nextConfig;
