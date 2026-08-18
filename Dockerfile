FROM node:20-alpine

# Working directory
WORKDIR /app

# Copy package requirements & install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY modules ./modules
COPY public ./public
COPY cli.js index.js install.js app.js worker.js ./

# Create data and logs directories
RUN mkdir -p /app/data /app/data/uploads /app/logs

# Expose port 3000
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production

# Application entry point
CMD ["node", "index.js"]
