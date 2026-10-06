FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /srv

COPY app ./app
COPY tests ./tests
COPY verify.py ./verify.py

EXPOSE 8080

HEALTHCHECK --interval=2s --timeout=3s --retries=30 --start-period=2s \
  CMD python -c "import json,urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3); sys.exit(0 if json.load(r)['status']=='ok' else 1)"

CMD ["python", "-m", "app.server"]
