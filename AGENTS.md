# Repository instructions

Write all documentation, source identifiers, CLI output, and commit messages in English.
Preserve the ownership boundaries in `.local/shared-llm-access-service-architecture.en.md`.
Keep OAuth and upstream credential refresh in CLIProxyAPI. Never commit credentials or runtime state.
Run the offline test suite for behavioral changes. Run the pinned backend contract suite for adapter changes.
Report unverified provider behavior explicitly; fake-provider tests are not live-provider verification.
