# The Potion code sandbox (X1) — Python + the analyst kit, non-root, on an
# internal-only network (see docker-compose.prod.yml: sandboxnet has
# internal: true, so this container has NO egress — pip below runs at BUILD
# time, on the build network, which is the only moment anything is fetched).
FROM python:3.12-slim

RUN pip install --no-cache-dir pandas numpy openpyxl matplotlib \
  && useradd --create-home --shell /usr/sbin/nologin sandbox

COPY sandbox_server.py /opt/sandbox/sandbox_server.py

USER sandbox
ENV SANDBOX_PORT=8790
EXPOSE 8790
CMD ["python", "/opt/sandbox/sandbox_server.py"]
