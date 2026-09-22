# Do the following after making changes to the code:

#### to rebuild this project, run the following commands:

cd /mnt/Websites/MagicTODO/web
npm run build

#### if uvicorn hangs, wait 15seconds, then force kill it.
systemctl --user stop magictodo &
stop_pid=$!
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if ! systemctl --user is-active --quiet magictodo; then
    wait "$stop_pid" 2>/dev/null || true
    break
  fi
  sleep 1
done
if systemctl --user is-active --quiet magictodo; then
  pid=$(systemctl --user show -p MainPID --value magictodo)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    kill -9 "$pid" || true
  fi
  systemctl --user kill -s SIGKILL magictodo || true
  sleep 1
fi

#### then restart the magictodo service:
systemctl --user stop magictodo
systemctl --user start magictodo
systemctl --user is-active magictodo