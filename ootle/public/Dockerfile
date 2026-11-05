# The image for everything around the router in ootle/public: Tor (the onion services and the way out), the relay,
# the gate, and the payment service with its own wallet daemon. Built from the repo root:
#   docker build -f ootle/public/Dockerfile -t ootlerouter-edge .
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS walletd
# tari_ootle_walletd from Tari's release, checked against the checksum the release publishes.
ARG TARGETARCH=amd64
ARG OOTLE=0.49.2-aa7b0c8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) a=x86_64 sum=ec8053f3dc23c80f59fd77e146cc69199e6fae2ddd6dbf6515df5da13735d280 ;; \
      arm64) a=arm64  sum=f58bdfc4069be8b3ddc31ee6fa6bcdb5bd56e0f824eccc8f960816cad46d3e9f ;; \
      *) echo "no walletd for $TARGETARCH" && exit 1 ;; esac \
 && curl -fsSLo /tmp/w.zip "https://github.com/tari-project/tari-ootle/releases/download/v${OOTLE%-*}/tari_ootle-$OOTLE-linux-$a.zip" \
 && echo "$sum  /tmp/w.zip" | sha256sum -c - \
 && unzip -j /tmp/w.zip tari_ootle_walletd -d /out && chmod 755 /out/tari_ootle_walletd

FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f
RUN apt-get update && apt-get install -y --no-install-recommends tor ca-certificates libdbus-1-3 libsystemd0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10100 --create-home --shell /usr/sbin/nologin edge \
 && install -d -o edge -g edge -m 700 /home/edge/tor /home/edge/wallet /home/edge/pay
COPY --from=walletd /out/tari_ootle_walletd /opt/walletd/tari_ootle_walletd
COPY ootle/pay/ /app/ootle/pay/
COPY ootle/deployments/ /app/ootle/deployments/
COPY ootle/public/*.mjs ootle/public/pay.sh /app/ootle/public/
RUN cd /app/ootle/pay && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
USER edge
