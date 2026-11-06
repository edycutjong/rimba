# Security

RIMBA only reads public Sui chain data and talks to the Tatum gateway and the Walrus Memory relayer. It never signs
transactions or holds funds.

- Credentials are read from `~/.config/tatum/` and `~/.config/memwal/`, never from the repository; `.env*` is ignored
  and gitleaks scans the full history in CI.
- Notes sent to Walrus Memory contain only public chain data (addresses, amounts, digests, checkpoint numbers). The
  managed relayer can read them.
- Report a vulnerability by opening a private security advisory on this repository.
