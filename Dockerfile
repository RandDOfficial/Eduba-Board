FROM node:20-alpine

# Working directory
WORKDIR /app

# Copy package requirements & install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY modules ./modules
COPY public ./public
COPY cli.js index.js install.js ./

# Expose port 3000
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production

# Application entry point
CMD ["node", "index.js"]
