# Main application Dockerfile
FROM python:3.11-alpine@sha256:8d8c6d3808243160605925c2a7ab2dc5c72d0e75651699b0639143613e0855b8

# Install system dependencies
RUN apk add --no-cache \
    postgresql-client \
    gcc \
    musl-dev \
    postgresql-dev

# Install Python dependencies
RUN pip install --no-cache-dir \
    requests \
    psycopg2-binary \
    pyjwt \
    cryptography \
    aiohttp \
    freezegun

# Create non-root user
RUN adduser -D -u 1000 appuser

WORKDIR /app

# Copy application code with proper ownership
COPY --chown=1000:1000 src/ /app/src/

# Set Python path
ENV PYTHONPATH=/app

# Switch to non-root user
USER 1000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import sys; sys.exit(0)" || exit 1

# Default command
CMD ["python", "-m", "src.mcp_server"]