#!/usr/bin/env bash
# Enable Tailscale Serve HTTPS on :8443 -> TTM-Todo on 127.0.0.1:8010
# Port 8443 leaves public :443 free for TTMFlow nginx.
# Requires Serve to be enabled on the tailnet (owner toggle):
#   https://login.tailscale.com/f/serve?node=njmXGTHDHM11CNTRL
set -euo pipefail

if ! tailscale serve --bg --https=8443 --yes http://127.0.0.1:8010; then
  echo "If Serve is not enabled on the tailnet, open:"
  echo "  https://login.tailscale.com/f/serve?node=njmXGTHDHM11CNTRL"
  echo "then run this script again."
  exit 1
fi

echo "Serve status:"
tailscale serve status
echo
echo "Try: https://nexserve.tail18d09c.ts.net:8443/api/health"
