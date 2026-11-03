# gmod-runner: the clean, pinned place gmod's CI jobs run.
# node (checkout, gmod), uv with Python 3.12 (projects' tests), git, and
# gmod itself at /opt/gmod, on PATH as `gmod`.
FROM node:22.22.1-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy \
    GMOD_HOME=/opt/gmod
RUN uv python install 3.12 && chmod -R a+rX /opt/uv-python
COPY . /opt/gmod
RUN cd /opt/gmod && npm ci --omit=dev --no-audit --no-fund && ln -s /opt/gmod/bin/gmod.mjs /usr/local/bin/gmod && chmod +x /opt/gmod/bin/gmod.mjs
ARG GMOD_COMMIT=dev
ENV GMOD_COMMIT=${GMOD_COMMIT}
LABEL org.opencontainers.image.source="https://github.com/soundheart-studios/gmod" \
      org.opencontainers.image.title="gmod-runner" \
      org.opencontainers.image.revision="${GMOD_COMMIT}"
