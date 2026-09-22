# Do the following after making changes to the code:

#### to rebuild this project, run the following commands:

cd /mnt/Websites/MagicTODO/web
npm run build

#### if uvicorn hangs, wait 15seconds, then force kill it.

#### then restart the magictodo service:
systemctl --user stop magictodo
systemctl --user start magictodo