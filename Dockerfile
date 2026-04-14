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

# Tell Playwright to use the system Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package.json and install ALL deps (including devDeps needed for TypeScript build)
COPY package*.json ./
RUN npm install

# Copy source and build TypeScript
COPY . .
RUN npm run build

# Railway sets PORT automatically; default 3000
ENV DASHBOARD_PORT=3000
EXPOSE 3000

RUN mkdir -p /app/data

CMD ["node", "dist/server.js"]
