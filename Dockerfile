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

RUN mkdir -p /workspace
RUN chown bun:bun /workspace

WORKDIR /workspace
USER bun
EXPOSE 80
VOLUME /workspace

ENTRYPOINT [ "bun", "/app/source/serve.ts" ]
