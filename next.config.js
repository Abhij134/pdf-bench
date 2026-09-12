/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow large PDF uploads (default Next.js limit is 4MB — resumes are small,
  // but some scanned multi-page PDFs can reach 20MB)
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
}

module.exports = nextConfig
