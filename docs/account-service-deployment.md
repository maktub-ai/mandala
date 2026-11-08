# Official account and relay service

The official service source, login/remote browser UI, deployment examples and build scripts now live in the **private** [maktub-ai/mandala-service](https://github.com/maktub-ai/mandala-service) repository, under `account-service/`. The static product website is in its independent `website/` folder.

Use the service repository's `account-service/README.md` for Google/GitHub/Resend credentials, DNS/TLS, building, testing and deployment. The desktop repository no longer builds, starts or publishes the official server. Resend provides transactional email; no mailbox server is bundled.

Desktop login, account-isolated local workspaces, native CLI execution and the encrypted connection client remain here. Conversations, tasks and memory stay local. Moving source does not deploy a service, replace an installed App, change existing repository visibility or remove previous Git history.

Desktop-only tests need no private repository access. Maintainers can run cross-repository compatibility tests by setting `MANDALA_ACCOUNT_SERVICE_SOURCE=/absolute/path/to/mandala-service/account-service` after installing that service's dependencies. See [development](development.md) for commands.
