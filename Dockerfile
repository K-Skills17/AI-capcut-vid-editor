FROM node:20-slim

# Install ffmpeg for audio extraction and Phase 2 video processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Create required directories
RUN mkdir -p uploads temp

EXPOSE 3000

CMD ["node", "src/server.js"]
