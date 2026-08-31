# The Potion browser hand (X6) — headless Chromium behind a minimal HTTP
# service. Unlike the code sandbox (zero egress by network law), this
# container MUST reach the public web — its containment is the in-process
# per-request SSRF guard (browser_server.mjs intercepts every request the
# page makes and aborts private/loopback/metadata addresses) plus the
# resource caps below. Runs as the image's unprivileged pwuser.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /srv
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.47.2

COPY browser_server.mjs /srv/browser_server.mjs

USER pwuser
ENV BROWSER_PORT=8791
EXPOSE 8791
CMD ["node", "/srv/browser_server.mjs"]
