FROM node:20-slim

# Playwright needs these system deps for Chromium
RUN apt-get update && apt-get install -y \
  chromium \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libxkbcommon0 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
  libcairo2 libatspi2.0-0 libgtk-3-0 \
  openssh-client git curl \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium (no separate download needed)
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (Docker layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Railway sets PORT automatically; default 3000
ENV DASHBOARD_PORT=3000
EXPOSE 3000

# Create data directory (Railway mounts persistent volume here)
RUN mkdir -p /app/data

CMD ["node", "dist/server.js"]
