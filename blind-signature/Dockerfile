# syntax=docker/dockerfile:1
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

FROM python:3.13-slim
RUN useradd --system --uid 10002 --home-dir /app blindsig \
    && mkdir -p /app/keys && chown blindsig /app/keys
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY app ./app
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 BLINDSIG_KEYS_DIR=/app/keys
# Las claves privadas (una por elección) se generan bajo demanda: montar como volumen.
VOLUME /app/keys
USER blindsig
# Puerto interno: NO se publica al host ni se expone en el Gateway.
EXPOSE 8100
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=2)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
