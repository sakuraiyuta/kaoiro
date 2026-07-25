# Find eligible builder and runner images on Docker Hub. We use Ubuntu/Debian
# instead of Alpine to avoid DNS resolution issues in production.
#
# https://hub.docker.com/r/hexpm/elixir/tags?name=ubuntu
# https://hub.docker.com/_/ubuntu/tags
#
# This file is based on these images:
#
#   - https://hub.docker.com/r/hexpm/elixir/tags - for the build image
#   - https://hub.docker.com/_/debian/tags?name=trixie-20260610-slim - for the release image
#   - https://pkgs.org/ - resource for finding needed packages
#   - Ex: docker.io/hexpm/elixir:1.20.1-erlang-29.0.2-debian-trixie-20260610-slim
#
# Keep these in step with the Elixir/OTP the CI `server` job runs the suite on
# (.gitea/workflows/ci.yml) — they diverged once, and OTP 26 turned out to be
# unable to compile this suite's Japanese test names at all (issue #150).
ARG ELIXIR_VERSION=1.20.1
ARG OTP_VERSION=29.0.2
ARG DEBIAN_VERSION=trixie-20260610-slim

ARG BUILDER_IMAGE="docker.io/hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION}"
ARG RUNNER_IMAGE="docker.io/debian:${DEBIAN_VERSION}"

# The build context is the REPOSITORY ROOT, not server/ — the dashboard
# was moved out to ../dashboard (issue #44) and has to stay reachable.
# docker-compose.yaml sets `context: ..` + `dockerfile: server/Dockerfile`;
# a bare `docker build` must be run as `docker build -f server/Dockerfile .`
# from the repo root. Hence every COPY below is repo-root relative.
#
# Dashboard build (Svelte 5 + Vite, pnpm via corepack — version pinned
# by dashboard/package.json packageManager). vite.config.ts outputs to
# ../server/priv/static, i.e. /app/server/priv/static here.
FROM docker.io/node:22-slim AS dashboard

WORKDIR /app/dashboard

RUN corepack enable

# pnpm-workspace.yaml carries the build-script approval (esbuild), so it
# has to be in the deps layer alongside the manifest and lockfile.
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY dashboard ./
RUN pnpm build

FROM ${BUILDER_IMAGE} AS builder

# install build dependencies
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential git \
  && rm -rf /var/lib/apt/lists/*

# prepare build dir
WORKDIR /app

# install hex + rebar
RUN mix local.hex --force \
  && mix local.rebar --force

# set build ENV
ENV MIX_ENV="prod"

# install mix dependencies
COPY server/mix.exs server/mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config

# copy compile-time config files before we compile dependencies
# to ensure any relevant config change will trigger the dependencies
# to be re-compiled.
COPY server/config/config.exs server/config/${MIX_ENV}.exs config/
RUN mix deps.compile

# priv carries the bundled persona pack (ADR-0008) and favicon/robots;
# the dashboard build from the dashboard stage is layered on top (the
# standard assets.deploy flow is replaced by the node stage above).
COPY server/priv priv
COPY --from=dashboard /app/server/priv/static priv/static

COPY server/lib lib

# Compile the release
RUN mix compile

# Changes to config/runtime.exs don't require recompiling the code
COPY server/config/runtime.exs config/

COPY server/rel rel
RUN mix release

# start a new build stage so that the final image will only contain
# the compiled release and other runtime necessities
FROM ${RUNNER_IMAGE} AS final

RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses6 locales ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Set the locale
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

WORKDIR "/app"
RUN chown nobody /app

# Persistence dir for restart-surviving DETS ledgers (session_pointers /
# agent_directory / permission_modes). A docker named volume mounted
# here inherits `nobody` ownership from this pre-created directory;
# without it the volume would land as root:root and the runtime user
# would fail to open the DETS file. See server/docker-compose.yaml
# `volumes:` and KAOIRO_*_PATH in config/runtime.exs.
RUN mkdir /var/lib/kaoiro && chown nobody /var/lib/kaoiro

# set runner ENV
ENV MIX_ENV="prod"

# Only copy the final release from the build stage
COPY --from=builder --chown=nobody:root /app/_build/${MIX_ENV}/rel/kaoiro_server ./

USER nobody

# If using an environment that doesn't automatically reap zombie processes, it is
# advised to add an init process such as tini via `apt-get install`
# above and adding an entrypoint. See https://github.com/krallin/tini for details
# ENTRYPOINT ["/tini", "--"]

CMD ["/app/bin/server"]
