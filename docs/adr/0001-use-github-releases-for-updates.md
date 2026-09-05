# Use GitHub Releases for application updates

Ashes of Pantheon QA Tool uses official, non-prerelease GitHub Releases from `yingyu4451/Ashes-of-Pantheon-QA-Tool` as its only update source. Every release contains one portable Windows executable and never an installer; the app opens the latest Release for manual replacement instead of invoking an installer or mutating its own executable. Development mode never performs a real update check. This preserves the no-install constraint and keeps replacement timing under QA control.
