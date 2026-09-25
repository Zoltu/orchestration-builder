FROM oven/bun:1.3.14-debian@sha256:431b37ce1acfed987e4f5b6c86a9f210ff63285a912fc5f21e18aeac0cb067ef

WORKDIR /app

# cache dependiences
COPY --chown=bun:bun ./package.json ./bun.lock ./bunfig.toml /app/
RUN --mount=type=cache,target=/home/bun/.bun/install/cache <<-EOF
	set -e
	bun install --frozen-lockfile
EOF

COPY --chown=bun:bun ./source/ /app/source/
COPY --chown=bun:bun ./guild/ /app/guild/
COPY --chown=bun:bun ./deployment/ /app/deployment/
# The benchmark suite is Foundry data, validated by `bun run validate-data` below.
COPY --chown=bun:bun ./benchmarks/ /app/benchmarks/
COPY --chown=bun:bun ./tsconfig.json /app/

RUN --mount=type=cache,target=/home/bun/.bun/install/cache <<-EOF
	set -e
	bun install --frozen-lockfile
	bun run typecheck
	bun run validate-data
	bun test --randomize --concurrent source/
	rm -rf node_modules
EOF

# BUILD_SHA bakes the checkout's commit into the image (build args are not affected by .dockerignore): pass it with `docker build --build-arg BUILD_SHA=$(git rev-parse HEAD) -t adaptive-orchestrator .` The sha is stripped of `"` and `\` before the bake so metacharacters cannot produce invalid JSON; the step runs bash explicitly because the parameter substitutions are bash expansions and debian's /bin/sh is dash.
ARG BUILD_SHA=""
RUN bash -c 'buildSha="${BUILD_SHA//\"/}"; buildSha="${buildSha//\\/}"; printf "{\"sha\":\"%s\",\"builtAt\":\"%s\"}" "$buildSha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /app/build-info.json'

RUN mkdir -p /workspace
RUN chown bun:bun /workspace

WORKDIR /workspace
USER bun
EXPOSE 80
VOLUME /workspace

ENTRYPOINT [ "bun", "/app/source/serve.ts" ]
