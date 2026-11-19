# Hostless xray node — VLESS + XHTTP (+TLS at the platform gateway)
# Base: Node 20 on Alpine (shell + node for the front proxy).
# The xray binary is the official Xray-core v26.3.27 linux/amd64 release
# binary (bundled from the verified local copy; no build/download step).
# Hostless builds from this repo's Dockerfile; the app must listen on
# 0.0.0.0:$PORT (platform-injected). Default transport is XHTTP
# (packet-up); WS is the fallback. Env vars UUID/WS_PATH/TRANSPORT are
# set in the Hostless console, NOT in this repo.
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js entrypoint.sh ./
COPY xray-bin/xray ./xray-bin/xray
RUN chmod +x /app/entrypoint.sh /app/xray-bin/xray
ENV PORT=8080 XRAY_PORT=10001 TRANSPORT=xhttp
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
