# Removal of the separate SIWC integration

Decision updated on 2026-10-14: Router4u supports `codex` and `api_key` profiles. The separate SIWC binding command, `chatgpt` profile, UI choice, and SIWC-specific request validator have been removed.

The relevant question is whether SIWC adds value for an application consuming Router4u. Both credential paths were hidden behind the same project-key authentication and Responses endpoint. We did not establish an SIWC-only model, required application feature, additional quota, or cost advantage. Maintaining a second binding workflow was therefore not justified for this router's current requirements.

The earlier decision to retain SIWC solely because it is an officially documented OSS/local-app integration was insufficient: that describes the upstream integration, not a demonstrated additional capability for Router4u's consuming applications. This removal does not assert that SIWC has no value in other products or that all real provider behavior is identical.

The prior source inspection found different upstream defaults in CLIProxyAPI 8.0.28: Codex uses `chatgpt.com/backend-api/codex`, while SIWC uses `api.openai.com/v1`. Official [SIWC inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) describes the latter. Endpoint differences do not alone prove an extra application feature, model, or quota. No live comparison was performed.

Ordinary Codex account login can still be labeled “Sign in with ChatGPT” by the provider. That login remains; the removed feature is the additional SIWC grant/binding. The old stopped-backend requirement was a Router4u integration precaution, not an OAuth protocol requirement.

See [migration guidance](authentication.md#migration-from-the-retired-siwc-profile). Existing credentials and historical records are preserved; active retired profiles fail validation instead of being silently reinterpreted.
