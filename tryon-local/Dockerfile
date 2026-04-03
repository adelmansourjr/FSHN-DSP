# syntax=docker/dockerfile:1
FROM node:20-slim AS base

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY . .

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787
CMD ["npm", "start"]
