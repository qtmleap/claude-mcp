# syntax=docker/dockerfile:1
# Build tools and package caches stay in this stage.
FROM node:24.19.0-trixie-slim AS builder
ARG CLAUDE_CODE_VERSION=2.1.289
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep tini openssh-client bash coreutils \
      findutils grep sed diffutils tar gzip patch
RUN --mount=type=cache,target=/root/.npm npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
WORKDIR /opt/claude-mcp
RUN --mount=type=bind,source=package.json,target=package.json,readonly \
    --mount=type=bind,source=package-lock.json,target=package-lock.json,readonly \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund
COPY package.json ./
COPY src ./src
RUN mkdir -p /runtime/workspace /runtime/home/node /runtime/state/jobs && chown -R 1000:1000 /runtime
# Keep Claude command-line tools, without the package manager.
# Debian 13 merges /bin and /lib into /usr; normalize the copied tree.
RUN mkdir -p /tools/usr/bin /tools/usr/lib /tools/usr/share \
 && cp -a /usr/lib/git-core /tools/usr/lib/ \
 && cp -a /usr/share/git-core /tools/usr/share/ \
 && mkdir -p /tools/etc/ssh /tools/usr/lib/openssh \
 && cp /etc/passwd /etc/group /tools/etc/ \
 && cp -a /etc/ssh/ssh_config /etc/ssh/ssh_config.d /tools/etc/ssh/ \
 && cp -a /usr/lib/openssh/. /tools/usr/lib/openssh/ \
 && for tool in $(dpkg-query -L bash dash coreutils findutils grep sed diffutils tar gzip patch git ripgrep openssh-client | awk '/^\/(usr\/)?bin\//'); do if [ -f "$tool" ] && [ -x "$tool" ]; then cp -L --parents "$tool" /tools/; fi; done \
 && if [ -d /tools/bin ]; then cp -a /tools/bin/. /tools/usr/bin/ && rm -rf /tools/bin; fi \
 && ln -sf dash /tools/usr/bin/sh \
 \
 && for tool in /tools/usr/bin/* /usr/lib/git-core/git-remote-http /usr/lib/openssh/*; do ldd "$tool" 2>/dev/null || true; done | awk '/=> \/lib\// {print $3}' | sort -u | while read lib; do case "$lib" in */libc.so.*|*/libpthread.so.*|*/libdl.so.*|*/libm.so.*|*/librt.so.*|*/libgcc_s.so.*) ;; *) cp --parents "$lib" /tools/ ;; esac; done \
 && chmod -R a-s /tools

# Copy runtime dependencies into Distroless; no installer or cache is shipped.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude
COPY --from=builder /usr/bin/tini /usr/bin/tini
COPY --link --from=builder --chown=1000:1000 /opt/claude-mcp/node_modules /opt/claude-mcp/node_modules
COPY --link --from=builder --chown=1000:1000 /opt/claude-mcp/package.json /opt/claude-mcp/package.json
COPY --link --from=builder --chown=1000:1000 /opt/claude-mcp/src /opt/claude-mcp/src
COPY --link --from=builder --chown=1000:1000 /runtime/state /var/lib/claude-mcp
COPY --link --from=builder --chown=1000:1000 /runtime/workspace /workspace
COPY --link --from=builder --chown=1000:1000 /runtime/home/node /home/node
USER 1000:1000
WORKDIR /opt/claude-mcp
ENV PATH=/usr/local/bin:/nodejs/bin:/usr/bin:/bin HOME=/home/node HOST=0.0.0.0 PORT=8877 CLAUDE_MCP_WORKSPACE=/workspace CLAUDE_MCP_JOB_DIR=/var/lib/claude-mcp/jobs
EXPOSE 8877
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/nodejs/bin/node", "src/main.mjs"]
CMD ["--transport", "http"]
COPY --link --from=builder /tools/usr/ /usr/
COPY --link --from=builder /tools/lib/ /usr/lib/
COPY --link --from=builder /tools/etc/ /etc/
ENV SHELL=/bin/bash
