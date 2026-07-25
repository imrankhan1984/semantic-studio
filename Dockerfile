# ---- Stage 1: build the React frontend ------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Python runtime serving API + static frontend -----------------
FROM python:3.12-slim
WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY examples ./examples
COPY --from=frontend /build/dist ./static

ENV STATIC_DIR=/app/static
# Persisted ontologies live here — mount a volume to keep them across
# container recreations (docker-compose.yml does this automatically).
ENV SEMANTIC_VIEWER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
