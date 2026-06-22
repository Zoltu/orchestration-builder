FROM oven/bun:1.3.14-debian@sha256:431b37ce1acfed987e4f5b6c86a9f210ff63285a912fc5f21e18aeac0cb067ef

USER bun

WORKDIR /app

COPY --chown=bun:bun source/ source/
COPY --chown=bun:bun guild/ guild/
# The integration test resolves benchmarks/hello_001 relative to the source tree.
COPY --chown=bun:bun benchmarks/ benchmarks/
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./

RUN --mount=type=cache,target=/home/bun/.bun/install/cache,uid=1000,gid=1000 <<-EOF
	set -e
	bun install --frozen-lockfile
	bun run typecheck
	bun test --randomize --concurrent source/
	rm -rf node_modules
EOF

EXPOSE 80
VOLUME /workspace
WORKDIR /workspace

ENTRYPOINT [ "bun", "source/serve.ts" ]
