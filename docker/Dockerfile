FROM node:20-alpine
LABEL maintainer="Tomasz"
LABEL org.opencontainers.image.source="https://github.com/tomaasz/agent-lb"
LABEL org.opencontainers.image.description="Universal Multi-Account Load Balancer, Quota Rotator & Web Dashboard for Claude Code & OpenAI Codex"

WORKDIR /app

# Install curl and git for health checks and setup sync
RUN apk add --no-cache curl git

# Copy package descriptors first for caching
COPY package.json ./

# Install production dependencies (zero external runtime dependencies by default)
RUN npm install --omit=dev

# Copy application files
COPY src/ ./src/
COPY setup/ ./setup/
COPY LICENSE README.md ./

# Set environment defaults
ENV NODE_ENV=production
ENV AGENT_LB_PORT=3456
ENV AGENT_LB_HOST=0.0.0.0
ENV AGENT_LB_CONFIG=/data/agent-lb.json
ENV CLAUDE_LB_PORT=3456
ENV CLAUDE_LB_HOST=0.0.0.0
ENV CLAUDE_LB_CONFIG=/data/agent-lb.json
ENV HOME=/data

# Create data directory for config and persistent state
RUN mkdir -p /data && chown -R node:node /app /data

VOLUME ["/data"]

EXPOSE 3456

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3456/agent-lb/status || curl -f http://localhost:3456/status || exit 1

ENTRYPOINT ["node", "src/index.js"]
CMD ["headless"]

