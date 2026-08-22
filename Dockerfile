FROM node:22-slim AS codex
RUN npm install -g @openai/codex@0.147.0

FROM python:3.12-slim

COPY --from=codex /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV CODEX_HOME=/codex-home

WORKDIR /app

COPY pyproject.toml README.md /app/
COPY src /app/src
RUN pip install --no-cache-dir .

COPY sql /app/sql

CMD ["python", "-m", "src.cli", "sync", "--days", "2"]
