# The Potion code sandbox (X1) — Python + the analyst kit, non-root, on an
# internal-only network (see docker-compose.prod.yml: sandboxnet has
# internal: true, so this container has NO egress — pip below runs at BUILD
# time, on the build network, which is the only moment anything is fetched).
FROM python:3.12-slim

# X7: toolchains for the sealed shell — chosen for OFFLINE usefulness (the
# network law means npm/pip installs can never run in here anyway): git for
# local repo operations, node for executing existing JS. Fetched at BUILD
# time on the build network, like everything else.
RUN apt-get update && apt-get install -y --no-install-recommends git nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir pandas numpy openpyxl matplotlib \
  && useradd --create-home --shell /usr/sbin/nologin sandbox

COPY sandbox_server.py /opt/sandbox/sandbox_server.py

# The sandbox OWNS this uid — nothing else runs as `sandbox` here. That is
# precisely what makes a per-uid RLIMIT_NPROC ceiling mean "this exec cannot
# fork-bomb", so the invariant is declared where it is established. Absent this,
# the server skips NPROC rather than applying a ceiling it cannot justify.
ENV POTION_SANDBOX_DEDICATED_UID=1
USER sandbox
ENV SANDBOX_PORT=8790
EXPOSE 8790
CMD ["python", "/opt/sandbox/sandbox_server.py"]
