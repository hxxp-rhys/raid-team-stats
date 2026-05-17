Raid Team Stats Uploader
========================

This program reads your World of Warcraft Great Vault (including the
World/Delve row), weekly Mythic+ runs, gear/enchants and talents from the
in-game addon's saved data and uploads it to https://raiders.hxxp.io so it
shows on your raid team's dashboard. WoW addons can't use the internet, so
this small companion does the upload.

Installed by the setup:
 - rts-companion.exe   the uploader (self-contained; no other software needed)
 - config.json         your settings (server, upload token, WoW folder)
 - run-hidden.vbs      used by the optional "run at startup" task
 - the addon           copied into <WoW>\_retail_\Interface\AddOns\RaidTeamStatsUploader

Using it:
 1. In WoW, enable the "Raid Team Stats Uploader" addon, log in, then
    /reload (or log out once) so the game writes its data file.
 2. If you chose "run at startup", it's already uploading in the background
    after each logon. Otherwise run rts-companion.exe (or with --watch to
    keep it syncing every 5 minutes).

Your upload token is like a password. Rotate or revoke it any time on the
website Account page. All uploads are sent over HTTPS (TLS).

Uninstalling removes the companion, the addon folder, and the startup task.
