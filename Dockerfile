FROM oven/bun:1.3.14-debian@sha256:431b37ce1acfed987e4f5b6c86a9f210ff63285a912fc5f21e18aeac0cb067ef

WORKDIR /app

# Aim apt at the Debian snapshot the base image was built against (its deb822 sources ship that snapshot's URL commented out above the live mirror).
# The live mirror drops superseded packages, so only the frozen snapshot keeps rebuilds working, and pinning its metadata digests below makes the install reproducible.
# Install git (the executor shells out to it for workspace bookkeeping), verifying the downloaded archive metadata against the digests captured from this base image's snapshot: a mismatch means the archive history changed under us and the build fails instead of installing from it.
# The digest check doubles as the guard on the sed pair — if they stop matching the sources file, the metadata lands under the live mirror's filenames and sha256sum -c fails on the missing snapshot paths.
RUN <<-EOF
	set -e
	sed -i 's|^URIs:|# URIs:|' /etc/apt/sources.list.d/debian.sources
	sed -i 's|^# http://snapshot|URIs: http://snapshot|' /etc/apt/sources.list.d/debian.sources
	apt-get update -o Acquire::Check-Valid-Until=false
	echo "d66e2e0619558676bf085c026cf699c59a61538906128e41909654c2ec9bf741  /var/lib/apt/lists/snapshot.debian.org_archive_debian-security_20260505T000000Z_dists_trixie-security_InRelease
	046525dd9b1481195c9cecde891d01cd9b3b4c7abb3b4dcde81023a6b6b88453  /var/lib/apt/lists/snapshot.debian.org_archive_debian_20260505T000000Z_dists_trixie-updates_InRelease
	7592e4ccb4658a58bfe485d3356b3c983bf8ccff7fca1f6091e4d4296284ed18  /var/lib/apt/lists/snapshot.debian.org_archive_debian_20260505T000000Z_dists_trixie_InRelease" | sha256sum -c
	apt-get install -y --no-install-recommends git
	rm -rf /var/lib/apt/lists/*
EOF

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
