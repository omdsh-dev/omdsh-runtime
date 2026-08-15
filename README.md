# OMDSH Runtime

A headless execution layer that reuses official Harness Profile, Bundle, Cordis, and package operations. It adds deterministic plan/apply, candidate generations, explicit confirmation, and previous-generation recovery without introducing another Loader or daemon. DSH Hub Workshop remains the only discovery, authoring, review, and feed authority.

The source repository is public. The `@omdsh/runtime` package is configured for public preview releases on npm under the `preview` dist-tag; preview releases never move `latest` implicitly.

The code boundary is one Toolkit repository with stable modules: `profile-pack` owns format, digest, signing, and composition checks; `pack-authoring` owns author manifests; `license` owns SPDX facts; `pack-instances` owns named installations; the CLI is a thin caller over those modules and existing Runtime/official DSH operations. The Hub never imports Runtime source. They exchange only versioned JSON Schemas, Registry snapshot IDs, locked packs, and signature results. These subpaths can later be published or moved into a `pack-core` package without changing the Pack format or CLI.

## Portable Profile Packs

`omdsh-profile-pack/v1` is a small, reviewable JSON distribution format. It records exact Registry project and Release IDs, author-owned sources pinned to full Git commits, the Registry snapshot, the observed `@deepseek-ai/dsh` version, and one Agent Preset. It does not copy plugin payloads, credentials, sessions, environment files, or absolute local paths.

```sh
# Start a pack with an admitted Registry Release and your own pinned plugin.
omdsh pack init research.pack.json --id research --preset code
omdsh pack add research.pack.json --release sample@1.2.3
omdsh pack add research.pack.json --source-id my-plugin --package @me/dsh-my-plugin --version 0.1.0 --repository https://github.com/me/dsh-my-plugin --ref <40-character-commit> --license MIT

# Review every component license, then bind runtime, Registry, hashes, and sources.
omdsh pack licenses research.pack.json
omdsh pack lock research.pack.json --output research-0.1.0.dshpack
omdsh pack test research.pack.json --profile web --trust-source

# Export the current managed Profile and an official preset.
omdsh pack export --profile web --preset standard --output web-0.1.0.dshpack

# Convert a Workshop-authored distribution manifest into a runtime-bound pack.
omdsh pack build research-0.1.0.distribution.json --output research-0.1.0.dshpack

# Verify the schema, hashes, and digest, then preflight the current Runtime, Registry, Profile, and trust options without Profile writes.
omdsh pack inspect research-0.1.0.dshpack
omdsh pack plan research-0.1.0.dshpack --profile web --trust-source

# Bind publisher provenance with an Ed25519 signature, then verify it explicitly.
omdsh pack sign research-0.1.0.dshpack --private-key publisher.pem --key-id example/releases-2026 --publisher example --source https://github.com/example/research --output research-0.1.0.signed.dshpack
omdsh pack inspect research-0.1.0.signed.dshpack --trusted-key publisher.pub

# Stage Registry-managed changes in a named instance. Activation remains separate.
omdsh pack apply research-0.1.0.signed.dshpack --instance research --profile web --trusted-key publisher.pub --require-signature
omdsh activate --profile web
omdsh confirm --profile web
omdsh pack instance research

# Preview and stage an update; rollback re-selects the previous Profile generation.
omdsh pack diff research-0.2.0.signed.dshpack --instance research
omdsh pack update research-0.2.0.signed.dshpack --instance research --trusted-key publisher.pub --require-signature
omdsh pack rollback --instance research
```

The source manifest is deliberately small: an ordered component list, one built-in preset, SPDX license expressions, and immutable sources. Git branches, tags, local paths, install scripts, secrets, and copied `node_modules` are not accepted. `pack licenses` reports each component's expression, source, SPDX link, and whether its terms need manual review; it is an inventory, not legal advice or an automatic license-compatibility verdict.

An admitted Registry Release retains its existing trust. An author-owned source is always `experimental-fixed-source`, requires `--trust-source` before candidate creation, and cannot be published as a trusted community distribution until that plugin passes Registry admission. A distribution made only from already admitted Releases does not repeat each plugin's human review; it needs only composition checks and one signature over the final digest.

Built-in presets (`standard`, `code`, `minimal`, and `cordis`) remain ID-only references to the official Harness installation. A custom preset is embedded as UTF-8 text only after rejecting symlinks, credential-like files or content, binary data, and absolute user paths. Applying embedded content requires `--trust-preset`; replacing an existing custom preset also requires `--replace-preset`.

Applying a pack replaces only plugins already governed by the pinned Registry snapshot plus fixed sources explicitly tracked by the same named pack instance. Other untracked local packages are preserved. A prepared candidate still requires explicit activation and runtime confirmation, with the existing previous-generation recovery path unchanged.

It can coexist with workspace-oriented Pack/Skill projection tools. Those tools are useful for mapping Skills, prompts, and editor configuration into a project, with search or allow-list controls. Profile Pack owns the release boundary instead: exact DSH Runtime and Registry Releases, author source commits, license facts, publisher signatures, and recoverable Profile generations. It does not replace Skill search or wrap another Pack format as a DSH plugin, so it does not create a second Loader.

Unsigned v1 packs remain readable for compatibility. A signed `omdsh-profile-pack-envelope/v1` is accepted for execution only when its publisher key is supplied and the Ed25519 signature verifies; `--require-signature` rejects legacy unsigned input. Named instances store only pack identity, exact Release selections, preset identity, publisher facts, and generation pointers. Rollback does not claim to reverse database, network, filesystem, or other external side effects, and embedded preset rollback remains outside Profile generations.
