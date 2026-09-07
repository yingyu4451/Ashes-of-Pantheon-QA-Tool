# Use GitHub Releases for application updates

Ashes of Pantheon QA Tool uses official, non-prerelease GitHub Releases from `yingyu4451/Ashes-of-Pantheon-QA-Tool` as its only update source. The original single-file/manual-replacement distribution decision is superseded by ADR-0002 at the user's request. Development mode never performs a real update check.

Update discovery uses GitHub's documented `releases/latest/download/update.json` redirect instead of the anonymous REST API: shared proxy IPs can exhaust the REST quota while Release downloads remain reachable. The updater validates the redirect against this repository's exact stable-version asset path, pins the manifest to that tag, validates its version and file records, and checks ZIP availability before offering an update; it does not require a user token or change proxy settings. Electron's `net.request` redirect event is used because its `net.fetch` rejects manual redirects and does not expose the final URL in the tested runtime.

Reference: [Linking to the latest release](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).
