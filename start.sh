#!/bin/sh

echo "Copying volume mounted mods to SPT directories"

cp -R /server/_mods/BepInEx /server/BepInEx
cp -R /server/_mods/user/mods /server/user/mods

echo "Starting SPT backend server"

./SPT.Server.exe