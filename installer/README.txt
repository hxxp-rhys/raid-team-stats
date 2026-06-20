Raid Team Stats Uploader
========================

This program reads your World of Warcraft Great Vault (including the
World/Delve row), weekly Mythic+ runs, gear/enchants and talents from the
in-game addon's saved data and uploads it to your Raid Stats site (the
address you entered during setup) so it shows on your raid team's
dashboard. WoW addons can't use the internet, so this small companion
does the upload.

Installed by the setup:
 - rts-companion.exe   the uploader (self-contained; no other software needed)
 - config.json         your settings (server, upload token, WoW folder),
                       kept in %LOCALAPPDATA%\RaidTeamStats (per-user;
                       not readable by other Windows accounts)
 - run-hidden.vbs      launches the uploader with no console window
 - the addon           copied into <WoW>\_retail_\Interface\AddOns\StatSmith

Using it:
 1. In WoW, enable the "Raid Team Stats" addon and log in. It writes its data
    file automatically within ~60s (no /reload needed).
 2. If you chose "run at startup", it's registered as a normal Windows
    startup app (NOT a scheduled task or service): it starts in your
    session at every sign-in and syncs hidden in the background every few
    minutes while you play. You can toggle it any time in Task Manager >
    Startup. To sync right now without waiting, double-click the desktop
    "Raid Team Stats - Upload Now" shortcut. (You can also run
    rts-companion.exe directly, or with --watch to poll every 5 minutes.)

In-game commands (type these in WoW chat; /raidteamstats works the same as /rts):
 - /rts now      collect a fresh snapshot now (the uploader sends it for you)
 - /rts status   show when your data was last collected
 - /rts version  show the installed addon version
 - /rts help     list the commands

Your upload token is like a password. Rotate or revoke it any time on the
website Account page. All uploads are sent over HTTPS (TLS).

Uninstalling removes the companion, the addon folder, and the startup
entry (and clears any leftover scheduled task from older versions).
