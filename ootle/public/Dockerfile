# The image for everything around the router in ootle/public: Tor (the onion services and the way out), the relay,
# the gate, and the payment service with its wallet. Built from the repo root:
#   docker build -f ootle/public/Dockerfile -t ootlerouter-edge .
FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f
RUN apt-get update && apt-get install -y --no-install-recommends tor ca-certificates libdbus-1-3 libsystemd0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10100 --create-home --shell /usr/sbin/nologin edge \
 && install -d -o edge -g edge -m 700 /home/edge/tor /home/edge/wallet /home/edge/pay
COPY ootle/pay/ /app/ootle/pay/
COPY ootle/deployments/ /app/ootle/deployments/
COPY ootle/public/*.mjs ootle/public/pay.sh /app/ootle/public/
RUN cd /app/ootle/pay && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
USER edge
