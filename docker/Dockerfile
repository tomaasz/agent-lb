FROM node:20-alpine
LABEL maintainer="Tomasz"
LABEL org.opencontainers.image.source="https://github.com/tomaasz/agent-lb"
LABEL org.opencontainers.image.description="Universal Multi-Account Load Balancer, Quota Rotator & Web Dashboard for Claude Code & OpenAI Codex"

WORKDIR /app

# Install tools used by setup scripts and repository verification
RUN apk add --no-cache bash curl git

# Copy package descriptors first for caching
COPY package.json package-lock.json ./

# Install production dependencies (zero external runtime dependencies by default)
RUN npm ci --omit=dev

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
  CMD node --input-type=module -e 'import {readFileSync} from "node:fs"; const c=JSON.parse(readFileSync(process.env.AGENT_LB_CONFIG)); const r=await fetch("http://127.0.0.1:"+(process.env.AGENT_LB_PORT||3456)+"/ready",{headers:{"x-api-key":c.proxy.apiKey},signal:AbortSignal.timeout(4000)}); process.exit(r.ok?0:1)'

ENTRYPOINT ["node", "src/index.js"]
CMD ["headless"]

