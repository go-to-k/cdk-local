# [0.16.0](https://github.com/go-to-k/cdk-local/compare/v0.15.0...v0.16.0) (2026-05-28)


### Features

* **run-task,start-service:** remap privileged container ports on macOS ([#80](https://github.com/go-to-k/cdk-local/issues/80)) ([b6c3649](https://github.com/go-to-k/cdk-local/commit/b6c3649f5faf429f42942ecd03345d09d44e7eab))

# [0.15.0](https://github.com/go-to-k/cdk-local/compare/v0.14.0...v0.15.0) (2026-05-28)


### Features

* **exports:** expose RegistrationHandle type from cloud-map-registry ([#79](https://github.com/go-to-k/cdk-local/issues/79)) ([4d8adee](https://github.com/go-to-k/cdk-local/commit/4d8adee45a0ef5e5be15550b3084de50b00bb59b))

# [0.14.0](https://github.com/go-to-k/cdk-local/compare/v0.13.3...v0.14.0) (2026-05-28)


### Features

* **exports:** expose env-resolver / stage-resolver / cloud-map-registry primitives ([#78](https://github.com/go-to-k/cdk-local/issues/78)) ([4818af0](https://github.com/go-to-k/cdk-local/commit/4818af00ca2e54a745cfc504bed0f62e77f94e5d))

## [0.13.3](https://github.com/go-to-k/cdk-local/compare/v0.13.2...v0.13.3) (2026-05-28)


### Bug Fixes

* **from-cfn-stack:** authenticate ECS container secrets with --profile ([#76](https://github.com/go-to-k/cdk-local/issues/76)) ([44aa584](https://github.com/go-to-k/cdk-local/commit/44aa584a918f0c08f9f1a4d873a44466e6dfec8e))

## [0.13.2](https://github.com/go-to-k/cdk-local/compare/v0.13.1...v0.13.2) (2026-05-28)


### Bug Fixes

* **invoke,start-api:** authenticate container-Lambda ECR pull with --profile ([#75](https://github.com/go-to-k/cdk-local/issues/75)) ([6469e88](https://github.com/go-to-k/cdk-local/commit/6469e88c178e2cd3be0fc2f4ad72aab7106b6234))

## [0.13.1](https://github.com/go-to-k/cdk-local/compare/v0.13.0...v0.13.1) (2026-05-28)


### Bug Fixes

* **from-cfn-stack:** authenticate ECR image pull with --profile ([#74](https://github.com/go-to-k/cdk-local/issues/74)) ([f04faf7](https://github.com/go-to-k/cdk-local/commit/f04faf755a0fda74eaee015747b8d7c0ff21ccc8))

# [0.13.0](https://github.com/go-to-k/cdk-local/compare/v0.12.0...v0.13.0) (2026-05-28)


### Bug Fixes

* **from-cfn-stack:** resolve ECR image Fn::Join via synthesized repo Arn ([#73](https://github.com/go-to-k/cdk-local/issues/73)) ([e421d7b](https://github.com/go-to-k/cdk-local/commit/e421d7b3f2d0cc69d4a5f5c3a2b90d94c33afd68))


### Features

* **start-api:** --watch watches the CDK app source tree ([#72](https://github.com/go-to-k/cdk-local/issues/72)) ([598fb59](https://github.com/go-to-k/cdk-local/commit/598fb591af4c20b631026352406cbee4c516b407))

# [0.12.0](https://github.com/go-to-k/cdk-local/compare/v0.11.3...v0.12.0) (2026-05-28)


### Features

* **index:** re-export start-api authorizer primitives for host shims ([#70](https://github.com/go-to-k/cdk-local/issues/70)) ([d44821e](https://github.com/go-to-k/cdk-local/commit/d44821e7ccaf25a17776cf604cb2b9b3fb78a976))

## [0.11.3](https://github.com/go-to-k/cdk-local/compare/v0.11.2...v0.11.3) (2026-05-28)


### Bug Fixes

* **start-service:** clearer not-found error for logical-ID-in-path ([#71](https://github.com/go-to-k/cdk-local/issues/71)) ([2e7bfae](https://github.com/go-to-k/cdk-local/commit/2e7bfae64a7bc0368b6dba5a928a0333fe831658))

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
