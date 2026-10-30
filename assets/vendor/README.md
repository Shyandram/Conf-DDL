# Vendored files

Served from the site itself instead of third-party CDNs (one less connection on first load). Each folder name carries
the version, so `sw.js` can keep them cached for good; upgrade by adding a new folder and pointing the page at it.

- `gsap-3.12.5/`: GSAP core and the Flip plugin, from cdnjs, unmodified. GreenSock standard licence:
  https://gsap.com/standard-license
- `geist-5.3.0/`: Geist and Geist Mono variable fonts (latin subset), from `@fontsource-variable` 5.3.0, unmodified.
  SIL Open Font License 1.1, see `geist-5.3.0/LICENSE`.
