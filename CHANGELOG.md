## [0.11.2](https://github.com/go-to-k/cdk-local/compare/v0.11.1...v0.11.2) (2026-05-28)


### Bug Fixes

* **from-cfn-stack:** use --profile region as CFn query fallback ([#68](https://github.com/go-to-k/cdk-local/issues/68)) ([d7c8394](https://github.com/go-to-k/cdk-local/commit/d7c8394cc504320209a60a527bff78b3aebf7e3c))

## [0.11.1](https://github.com/go-to-k/cdk-local/compare/v0.11.0...v0.11.1) (2026-05-28)


### Bug Fixes

* **synthesis:** apply --profile/--region to toolkit-lib lookups ([#66](https://github.com/go-to-k/cdk-local/issues/66)) ([8bad563](https://github.com/go-to-k/cdk-local/commit/8bad5637019dbf44b5c4444f5f39c7d1eb4a7136))

# [0.11.0](https://github.com/go-to-k/cdk-local/compare/v0.10.0...v0.11.0) (2026-05-28)


### Features

* **index:** re-export start-api route-resolution layer for host shims ([#65](https://github.com/go-to-k/cdk-local/issues/65)) ([71ee9f5](https://github.com/go-to-k/cdk-local/commit/71ee9f566deb38c4489de55f09312f73aacf821b))

# [0.10.0](https://github.com/go-to-k/cdk-local/compare/v0.9.0...v0.10.0) (2026-05-28)


### Features

* **from-cfn-stack:** recover Lambda env GetAtt values from deployed function config ([#64](https://github.com/go-to-k/cdk-local/issues/64)) ([79835fc](https://github.com/go-to-k/cdk-local/commit/79835fceaed568e4e39311b8500ffce85ba03bf4))

# [0.9.0](https://github.com/go-to-k/cdk-local/compare/v0.8.0...v0.9.0) (2026-05-28)

# [0.8.0](https://github.com/go-to-k/cdk-local/compare/v0.7.1...v0.8.0) (2026-05-28)


### Features

* **index:** re-export local leaf helpers for host shims ([#62](https://github.com/go-to-k/cdk-local/issues/62)) ([ef5b6db](https://github.com/go-to-k/cdk-local/commit/ef5b6db992158889ff0f403ce7ac88d98a41ef54))

## [0.7.1](https://github.com/go-to-k/cdk-local/compare/v0.7.0...v0.7.1) (2026-05-28)


### Bug Fixes

* **start-api:** explain unverifiable SigV4 instead of bare "Denying" ([#61](https://github.com/go-to-k/cdk-local/issues/61)) ([65d0a9c](https://github.com/go-to-k/cdk-local/commit/65d0a9c8e09a9d52a3fd1652350c8fc416f1f442))

# [0.7.0](https://github.com/go-to-k/cdk-local/compare/v0.6.0...v0.7.0) (2026-05-28)


### Features

* **start-api:** seed container AWS_REGION from profile / synth / --stack-region ([#60](https://github.com/go-to-k/cdk-local/issues/60)) ([b5ad957](https://github.com/go-to-k/cdk-local/commit/b5ad9570039e64e6941cb87659ac96fc3f7fa508))

# [0.6.0](https://github.com/go-to-k/cdk-local/compare/v0.5.2...v0.6.0) (2026-05-28)


### Features

* **start-api:** add --all-stacks for multi-stack union serving ([#59](https://github.com/go-to-k/cdk-local/issues/59)) ([54a2778](https://github.com/go-to-k/cdk-local/commit/54a27782d6bcec5b79b037993d1abc1e88d13054))

## [0.5.2](https://github.com/go-to-k/cdk-local/compare/v0.5.1...v0.5.2) (2026-05-28)


### Bug Fixes

* **docker:** keep secret/credential env out of docker run argv ([#58](https://github.com/go-to-k/cdk-local/issues/58)) ([612f444](https://github.com/go-to-k/cdk-local/commit/612f444ef209681ab2953573785f6a83e4ed03ae))

## [0.5.1](https://github.com/go-to-k/cdk-local/compare/v0.5.0...v0.5.1) (2026-05-28)


### Bug Fixes

* **from-cfn-stack:** paginate ListStackResources past the 100 cap ([#56](https://github.com/go-to-k/cdk-local/issues/56)) ([2617472](https://github.com/go-to-k/cdk-local/commit/2617472c29409cdc817d983cab7e569dcd995f33))

# [0.5.0](https://github.com/go-to-k/cdk-local/compare/v0.4.0...v0.5.0) (2026-05-28)


### Features

* add embedConfig for host-CLI rebranding ([#51](https://github.com/go-to-k/cdk-local/issues/51)) ([a124d00](https://github.com/go-to-k/cdk-local/commit/a124d0097f5c4ac3214933a640b78cb310c3c061))

# [0.4.0](https://github.com/go-to-k/cdk-local/compare/v0.3.1...v0.4.0) (2026-05-28)


### Features

* **start-api:** auto-relax SigV4 for OAC-fronted AWS_IAM Function URLs ([#49](https://github.com/go-to-k/cdk-local/issues/49)) ([8df85da](https://github.com/go-to-k/cdk-local/commit/8df85dac19c158147ed20c2a720ece0dad5c09e0))

## [0.3.1](https://github.com/go-to-k/cdk-local/compare/v0.3.0...v0.3.1) (2026-05-27)


### Bug Fixes

* **start-api:** emit --from-cfn-stack redundancy tip at most once per server lifetime ([#48](https://github.com/go-to-k/cdk-local/issues/48)) ([d11752c](https://github.com/go-to-k/cdk-local/commit/d11752cbee4339eef15e9860f9b4d40af1facd53))

# [0.3.0](https://github.com/go-to-k/cdk-local/compare/v0.2.0...v0.3.0) (2026-05-27)


### Features

* **start-api:** tip on redundant --from-cfn-stack + infer stack from target prefix ([#45](https://github.com/go-to-k/cdk-local/issues/45)) ([6381f2a](https://github.com/go-to-k/cdk-local/commit/6381f2a792e2c004ca6022b3325038bd50a98897))

# [0.2.0](https://github.com/go-to-k/cdk-local/compare/v0.1.1...v0.2.0) (2026-05-27)


### Features

* **cli:** infer cdkl start-api synth target from --from-cfn-stack ([#44](https://github.com/go-to-k/cdk-local/issues/44)) ([40b1e22](https://github.com/go-to-k/cdk-local/commit/40b1e2287ce44b572ab4d4794d8d2caa82de6f18))

## [0.1.1](https://github.com/go-to-k/cdk-local/compare/v0.1.0...v0.1.1) (2026-05-27)


### Bug Fixes

* **synth:** stop coloring CDK app stderr progress lines as red ([#43](https://github.com/go-to-k/cdk-local/issues/43)) ([6545498](https://github.com/go-to-k/cdk-local/commit/65454989bc9c2eee328c28b47ccad2e8b27725ed))

# [0.1.0](https://github.com/go-to-k/cdk-local/compare/v0.0.1...v0.1.0) (2026-05-27)


### Features

* **cli:** accept CDK display path keys in --env-vars ([#41](https://github.com/go-to-k/cdk-local/issues/41)) ([f34fd59](https://github.com/go-to-k/cdk-local/commit/f34fd59db551e2ec644086a008aa92a718615f26))

# Changelog

All notable changes to this project will be documented in this file.
Entries below this line are auto-generated by semantic-release on each merge to `main`.
