# [0.39.0](https://github.com/go-to-k/cdk-local/compare/v0.38.0...v0.39.0) (2026-05-29)


### Features

* **invoke-agentcore:** stream SSE /invocations responses incrementally ([#138](https://github.com/go-to-k/cdk-local/issues/138)) ([abdc024](https://github.com/go-to-k/cdk-local/commit/abdc02498d944ed2fd490509938f24dfd4381d02))

# [0.38.0](https://github.com/go-to-k/cdk-local/compare/v0.37.1...v0.38.0) (2026-05-29)


### Features

* **invoke-agentcore:** verify inbound JWT auth (customJwtAuthorizer) ([#135](https://github.com/go-to-k/cdk-local/issues/135)) ([f6fc342](https://github.com/go-to-k/cdk-local/commit/f6fc3420d19142c87d26ef1497ee20a2e9b2f9f1))

## [0.37.1](https://github.com/go-to-k/cdk-local/compare/v0.37.0...v0.37.1) (2026-05-29)


### Bug Fixes

* **ecs:** always log the published host port ([#134](https://github.com/go-to-k/cdk-local/issues/134)) ([0689d35](https://github.com/go-to-k/cdk-local/commit/0689d3524bed4108c0148c24dc770cdd5707e72f))

# [0.37.0](https://github.com/go-to-k/cdk-local/compare/v0.36.1...v0.37.0) (2026-05-29)


### Features

* **start-alb:** local ALB front-door command for ECS services ([#86](https://github.com/go-to-k/cdk-local/issues/86)) ([#125](https://github.com/go-to-k/cdk-local/issues/125)) ([d20d4be](https://github.com/go-to-k/cdk-local/commit/d20d4be19769069b700cdafac00ccb7726437289))

## [0.36.1](https://github.com/go-to-k/cdk-local/compare/v0.36.0...v0.36.1) (2026-05-29)


### Bug Fixes

* **invoke-agentcore:** validate --event before starting the container ([#132](https://github.com/go-to-k/cdk-local/issues/132)) ([08a1b1c](https://github.com/go-to-k/cdk-local/commit/08a1b1c66feeea6ff06ac94d390f250d629ba8b9))

# [0.36.0](https://github.com/go-to-k/cdk-local/compare/v0.35.1...v0.36.0) (2026-05-29)


### Features

* **invoke-agentcore:** run Bedrock AgentCore Runtime agents locally ([#126](https://github.com/go-to-k/cdk-local/issues/126)) ([c967f9c](https://github.com/go-to-k/cdk-local/commit/c967f9cbf18c16fe64a9485157baaa7a052f890c))

## [0.35.1](https://github.com/go-to-k/cdk-local/compare/v0.35.0...v0.35.1) (2026-05-29)


### Bug Fixes

* **from-cfn-stack:** keep decrypted SecureString SSM values off the docker argv ([#121](https://github.com/go-to-k/cdk-local/issues/121)) ([c46a39b](https://github.com/go-to-k/cdk-local/commit/c46a39be9fd17cd355d3c7e0efc1cd4a1b640323))

# [0.35.0](https://github.com/go-to-k/cdk-local/compare/v0.34.0...v0.35.0) (2026-05-29)


### Features

* **picker:** arrow-key bulk select, confirmation, kind-grouped multi-select ([#117](https://github.com/go-to-k/cdk-local/issues/117)) ([95e6296](https://github.com/go-to-k/cdk-local/commit/95e629672c2a5cae9fa62765c3523c439a0ce616))

# [0.34.0](https://github.com/go-to-k/cdk-local/compare/v0.33.0...v0.34.0) (2026-05-29)


### Features

* **exports:** expose file-watcher + watch-predicates + watch-config for watch-source shim consumers ([#116](https://github.com/go-to-k/cdk-local/issues/116)) ([1c62469](https://github.com/go-to-k/cdk-local/commit/1c624698309980847dc7e53c4d97e46b35c58c76))

# [0.33.0](https://github.com/go-to-k/cdk-local/compare/v0.32.0...v0.33.0) (2026-05-29)


### Features

* **exports:** expose docker-image-builder build primitives + LocalInvokeBuildError for shim consumers ([#114](https://github.com/go-to-k/cdk-local/issues/114)) ([eea0bdf](https://github.com/go-to-k/cdk-local/commit/eea0bdfa2ec6d4ecc9ac9ca9821d5f1d19bf89b5))

# [0.32.0](https://github.com/go-to-k/cdk-local/compare/v0.31.0...v0.32.0) (2026-05-29)


### Features

* **exports:** parameterize sigv4 strictness messaging via embedConfig + expose http-server/authorizer/sigv4 symbols for shim consumers ([#113](https://github.com/go-to-k/cdk-local/issues/113)) ([9233a3c](https://github.com/go-to-k/cdk-local/commit/9233a3c33144082e4ea795f4eb98add47e36fc8a))

# [0.31.0](https://github.com/go-to-k/cdk-local/compare/v0.30.0...v0.31.0) (2026-05-28)

# [0.30.0](https://github.com/go-to-k/cdk-local/compare/v0.29.1...v0.30.0) (2026-05-28)


### Features

* **exports:** expose cloud-map + integration-response resolvers and error classes for shim consumers ([#109](https://github.com/go-to-k/cdk-local/issues/109)) ([8865eda](https://github.com/go-to-k/cdk-local/commit/8865edaed3da5db80ef07c917493122f27c5ae3c))

## [0.29.1](https://github.com/go-to-k/cdk-local/compare/v0.29.0...v0.29.1) (2026-05-28)


### Bug Fixes

* **start-service:** print the shutdown prompt on its own line ([#108](https://github.com/go-to-k/cdk-local/issues/108)) ([e770cc1](https://github.com/go-to-k/cdk-local/commit/e770cc1436805b386976ce0a935f37124eb80983))

# [0.29.0](https://github.com/go-to-k/cdk-local/compare/v0.28.2...v0.29.0) (2026-05-28)


### Features

* **exports:** expose bufferToBody from websocket-body for shim consumers ([#106](https://github.com/go-to-k/cdk-local/issues/106)) ([e772e2c](https://github.com/go-to-k/cdk-local/commit/e772e2cf3cdf70df17244d2d18b3bea5f1b9f657))

## [0.28.2](https://github.com/go-to-k/cdk-local/compare/v0.28.1...v0.28.2) (2026-05-28)


### Bug Fixes

* **hooks:** use subshell cd instead of unsupported gh -C in non-english-text-gate ([#105](https://github.com/go-to-k/cdk-local/issues/105)) ([6b9e05a](https://github.com/go-to-k/cdk-local/commit/6b9e05aa1045286114916a29e06caad650989adc))

## [0.28.1](https://github.com/go-to-k/cdk-local/compare/v0.28.0...v0.28.1) (2026-05-28)


### Bug Fixes

* **synthesis:** read --app cloud assembly directory instead of exec'ing it ([#104](https://github.com/go-to-k/cdk-local/issues/104)) ([e4ea5a4](https://github.com/go-to-k/cdk-local/commit/e4ea5a46410a7155990c52cd0b555d3efd6e3eb5))

# [0.28.0](https://github.com/go-to-k/cdk-local/compare/v0.27.0...v0.28.0) (2026-05-28)


### Features

* **from-cfn-stack:** resolve AWS::SSM::Parameter::Value parameters from SSM ([#101](https://github.com/go-to-k/cdk-local/issues/101)) ([221bf4f](https://github.com/go-to-k/cdk-local/commit/221bf4fe882f5ffd09427ab4bf46c227e4c1248e))

# [0.27.0](https://github.com/go-to-k/cdk-local/compare/v0.26.0...v0.27.0) (2026-05-28)


### Features

* **start-service:** reclaim leaked shared networks left by interrupted runs ([#96](https://github.com/go-to-k/cdk-local/issues/96)) ([15e027c](https://github.com/go-to-k/cdk-local/commit/15e027c41bf388b7e72fb26307352938e526723f))

# [0.26.0](https://github.com/go-to-k/cdk-local/compare/v0.25.0...v0.26.0) (2026-05-28)


### Features

* **list:** readable list output, interactive-first docs, picker key hints ([#102](https://github.com/go-to-k/cdk-local/issues/102)) ([501ea95](https://github.com/go-to-k/cdk-local/commit/501ea95a14b38c5819f48015ee2dc6364840001b))

# [0.25.0](https://github.com/go-to-k/cdk-local/compare/v0.24.0...v0.25.0) (2026-05-28)


### Features

* **interactive:** add `-i`/`--interactive` target picker to the run commands ([#98](https://github.com/go-to-k/cdk-local/issues/98)) ([7de4ab0](https://github.com/go-to-k/cdk-local/commit/7de4ab020d7a9766da200520023fab6f46f27d03))

# [0.24.0](https://github.com/go-to-k/cdk-local/compare/v0.23.0...v0.24.0) (2026-05-28)


### Features

* **exports:** expose state-resolver substitution primitives ([#97](https://github.com/go-to-k/cdk-local/issues/97)) ([717b5bd](https://github.com/go-to-k/cdk-local/commit/717b5bd5ee71faf3f0c837005967aab1d97d5329))

# [0.23.0](https://github.com/go-to-k/cdk-local/compare/v0.22.0...v0.23.0) (2026-05-28)


### Features

* **list:** add `cdkl list` / `ls` to enumerate runnable targets ([#95](https://github.com/go-to-k/cdk-local/issues/95)) ([e47ab33](https://github.com/go-to-k/cdk-local/commit/e47ab336addfb8436588ef38c9e9ee57a19c29f2))

# [0.22.0](https://github.com/go-to-k/cdk-local/compare/v0.21.0...v0.22.0) (2026-05-28)


### Features

* **exports:** expose cors-handler + intrinsic-image primitives ([#92](https://github.com/go-to-k/cdk-local/issues/92)) ([857e82e](https://github.com/go-to-k/cdk-local/commit/857e82e4be65d9716f8aa531a46e2fafc5893d86))

# [0.21.0](https://github.com/go-to-k/cdk-local/compare/v0.20.0...v0.21.0) (2026-05-28)


### Features

* **exports:** expose docker-version / api-server-grouping / layer-arn-materializer primitives ([#91](https://github.com/go-to-k/cdk-local/issues/91)) ([e49f664](https://github.com/go-to-k/cdk-local/commit/e49f6640297c373b18a9188d68041c615d04bb90))

# [0.20.0](https://github.com/go-to-k/cdk-local/compare/v0.19.1...v0.20.0) (2026-05-28)


### Features

* **exports:** expose setEmbedConfig / getEmbedConfig / resetEmbedConfig ([#85](https://github.com/go-to-k/cdk-local/issues/85)) ([1f0926a](https://github.com/go-to-k/cdk-local/commit/1f0926a860cb63d143d8e7c81e16d5bf543568a9))

## [0.19.1](https://github.com/go-to-k/cdk-local/compare/v0.19.0...v0.19.1) (2026-05-28)


### Bug Fixes

* **start-service:** stop logging service warnings twice ([#84](https://github.com/go-to-k/cdk-local/issues/84)) ([696914c](https://github.com/go-to-k/cdk-local/commit/696914c95ffa3e64bb10f6a99353903990cb7d00))

# [0.19.0](https://github.com/go-to-k/cdk-local/compare/v0.18.0...v0.19.0) (2026-05-28)


### Features

* **start-service:** surface container log tail when a replica exits ([#83](https://github.com/go-to-k/cdk-local/issues/83)) ([22f95cf](https://github.com/go-to-k/cdk-local/commit/22f95cf5a7539035d6c27e901e345488182c8808))

# [0.18.0](https://github.com/go-to-k/cdk-local/compare/v0.17.0...v0.18.0) (2026-05-28)


### Features

* **run-task,start-service:** explicit --host-port override; drop macOS auto-remap ([#82](https://github.com/go-to-k/cdk-local/issues/82)) ([c5e623e](https://github.com/go-to-k/cdk-local/commit/c5e623e62676061c5559a8346169e62935ee5e46))

# [0.17.0](https://github.com/go-to-k/cdk-local/compare/v0.16.0...v0.17.0) (2026-05-28)


### Features

* **exports:** expose runtime-image + websocket-event/mgmt-api primitives ([#81](https://github.com/go-to-k/cdk-local/issues/81)) ([7e31983](https://github.com/go-to-k/cdk-local/commit/7e31983ef5fa7e692f0b1cfe87c75899222b9b86))

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
