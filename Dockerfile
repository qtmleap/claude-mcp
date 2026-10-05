FROM node:24.19.0-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.289
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && mkdir -p /opt/claude-mcp /Users/devonly/Developer \
 && chown -R node:node /opt/claude-mcp /Users/devonly/Developer
WORKDIR /opt/claude-mcp
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
USER node
ENV HOST=0.0.0.0 PORT=8877 CLAUDE_MCP_WORKSPACE=/Users/devonly/Developer
EXPOSE 8877
ENTRYPOINT ["tini", "-s", "--", "node", "src/main.mjs"]
CMD ["--transport", "http"]
