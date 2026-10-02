# Do the following after making changes to the code:

#### to rebuild this project, run the following commands:

cd /mnt/Websites/MagicTODO/web
npm run build


#### then restart the magictodo service:
#### we force kill it as connections can hang and prevent the service from stopping
systemctl --user stop magictodo
#### wait 3seconds before force killing it
sleep 3
systemctl --user kill -s SIGKILL magictodo
systemctl --user start magictodo
systemctl --user is-active magictodo