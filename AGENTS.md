to rebuild this project, run the following commands:

cd /mnt/Websites/MagicTODO/web
npm run build

then restart the magictodo service:

systemctl --user stop magictodo
systemctl --user start magictodo