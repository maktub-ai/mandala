# Windows Authenticode verification probe (not an updater)

This offline maintainer probe is not packaged with the desktop app. It does
not install, run or download its input, and it does not change trust stores
or registry settings. A successful result is evidence about an open file
during that invocation, not permission to open the same path after it exits.

Use existing x64 MSVC and Windows SDK tooling in a developer shell. Keep all
generated files in a disposable directory. The inputs are the canonical local
path, the size and SHA-256 just verified against the canonical signed Windows
release receipt, and the expected SHA-256 of the DER SubjectPublicKeyInfo of
the leaf Authenticode publisher. That publisher is determined independently
by the release policy; never infer the expected pin from the input executable.
Do not use this probe as a substitute for authenticating the signed receipt.

See the source Result enum for exit codes: 0 verifies the exact bytes and
embedded publisher; 10–13 deny malformed arguments, unsafe paths, size or
digest mismatches; 20–23 deny missing/failed OS trust, ambiguous signatures,
wrong publisher or unavailable verification. Cache-only whole-chain
revocation failures are not retried with weakened settings. No public
installation or signing claim follows from synthetic rejection tests.

With the absolute path to the freshly compiled probe in
MANDALA_WINDOWS_TRUST_HELPER, run:
```sh
node --test scripts/windows-authenticode-native.test.mjs scripts/windows-release-receipt.test.mjs
```

Neither test executes the input file. Native successful acceptance of a
signed release fixture, installed payload architecture independent of the
NSIS bootstrap stub, and an at-use binding that keeps the same protected
installer until the operating system opens it are still required before any
automatic installation work.
