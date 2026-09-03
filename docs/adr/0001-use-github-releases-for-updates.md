# Use GitHub Releases for application updates

Ashes of Pantheon QA Tool uses official, non-prerelease GitHub Releases from `yingyu4451/Ashes-of-Pantheon-QA-Tool` as its only update source. Installed NSIS builds check in the background and on demand, but downloading and restarting to install remain explicit user actions; development mode never performs a real update check. This keeps source commits from becoming accidental releases and keeps installation timing under QA control.
