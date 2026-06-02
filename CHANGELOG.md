## [0.81.1](https://github.com/go-to-k/cdk-local/compare/v0.81.0...v0.81.1) (2026-06-02)


### Bug Fixes

* **studio:** terminate the client response when the upstream dies mid-stream ([#282](https://github.com/go-to-k/cdk-local/issues/282)) ([#295](https://github.com/go-to-k/cdk-local/issues/295)) ([10b9b4d](https://github.com/go-to-k/cdk-local/commit/10b9b4dc84169486c77f5e16ac03f17811e53965))

# [0.81.0](https://github.com/go-to-k/cdk-local/compare/v0.80.0...v0.81.0) (2026-06-02)


### Features

* **studio:** Phase 1 slice C2 — capture every served request on the timeline ([#282](https://github.com/go-to-k/cdk-local/issues/282)) ([#294](https://github.com/go-to-k/cdk-local/issues/294)) ([31cc9de](https://github.com/go-to-k/cdk-local/commit/31cc9de8db37e8f66a522e958b91ef7aa0194394))

# [0.80.0](https://github.com/go-to-k/cdk-local/compare/v0.79.0...v0.80.0) (2026-06-02)


### Features

* **studio:** Phase 1 slice C1 — start/stop a long-running API serve from the studio UI ([#282](https://github.com/go-to-k/cdk-local/issues/282)) ([#293](https://github.com/go-to-k/cdk-local/issues/293)) ([cfd8f2d](https://github.com/go-to-k/cdk-local/commit/cfd8f2dc3e50a2fd938abc4d6b4e0c8ffba1154e))

# [0.79.0](https://github.com/go-to-k/cdk-local/compare/v0.78.1...v0.79.0) (2026-06-02)


### Features

* **studio:** Phase 1 slice B — invoke a Lambda from the studio UI ([#292](https://github.com/go-to-k/cdk-local/issues/292)) ([9e5075c](https://github.com/go-to-k/cdk-local/commit/9e5075c450692ff056c7f2492cc3eb764463852c))

## [0.78.1](https://github.com/go-to-k/cdk-local/compare/v0.78.0...v0.78.1) (2026-06-02)


### Bug Fixes

* **studio:** abort SSE test connections to stop a flaky vitest worker crash ([#290](https://github.com/go-to-k/cdk-local/issues/290)) ([00f8a19](https://github.com/go-to-k/cdk-local/commit/00f8a19d6fb2ac8a4a292bdd397ffb8b8d83bde1))

# [0.78.0](https://github.com/go-to-k/cdk-local/compare/v0.77.1...v0.78.0) (2026-06-02)


### Features

* **studio:** Phase 1 slice A — cdkl studio control-plane console shell ([#289](https://github.com/go-to-k/cdk-local/issues/289)) ([7d91330](https://github.com/go-to-k/cdk-local/commit/7d91330173bdab9508dd48cad365005f37d3b810))

## [0.77.1](https://github.com/go-to-k/cdk-local/compare/v0.77.0...v0.77.1) (2026-06-01)


### Bug Fixes

* **invoke-agentcore:** `--ws` interactive REPL UX — trailing newline + `>` prompt + skip empty Enter ([#276](https://github.com/go-to-k/cdk-local/issues/276)) ([#278](https://github.com/go-to-k/cdk-local/issues/278)) ([1d63f77](https://github.com/go-to-k/cdk-local/commit/1d63f772d77956858054169ace167e84a00a8cdd))

# [0.77.0](https://github.com/go-to-k/cdk-local/compare/v0.76.0...v0.77.0) (2026-06-01)

# [0.76.0](https://github.com/go-to-k/cdk-local/compare/v0.75.0...v0.76.0) (2026-06-01)


### Features

* **invoke-agentcore:** add --watch on the /ws session paths ([#255](https://github.com/go-to-k/cdk-local/issues/255)) ([#270](https://github.com/go-to-k/cdk-local/issues/270)) ([6585513](https://github.com/go-to-k/cdk-local/commit/6585513f487f474bbc7abad678a89fa9e608a4a4))

# [0.75.0](https://github.com/go-to-k/cdk-local/compare/v0.74.0...v0.75.0) (2026-06-01)


### Features

* **start-api:** `--assume-role-auto` boolean flag auto-resolves each routed Lambda's own execution role ([#256](https://github.com/go-to-k/cdk-local/issues/256) Option 1) ([#271](https://github.com/go-to-k/cdk-local/issues/271)) ([22555b2](https://github.com/go-to-k/cdk-local/commit/22555b21734bcb39e35eb54735edddbfcac698a8))

# [0.74.0](https://github.com/go-to-k/cdk-local/compare/v0.73.6...v0.74.0) (2026-06-01)


### Features

* **docker:** show interactive spinner during long docker build / pull ([#269](https://github.com/go-to-k/cdk-local/issues/269)) ([14665e0](https://github.com/go-to-k/cdk-local/commit/14665e0333d13eca8e09555d5b866ef389ac458d))

## [0.73.6](https://github.com/go-to-k/cdk-local/compare/v0.73.5...v0.73.6) (2026-06-01)


### Bug Fixes

* **start-service,start-alb:** bump shadow-ready timeout to 60s + add --shadow-ready-timeout flag ([#265](https://github.com/go-to-k/cdk-local/issues/265)) ([#266](https://github.com/go-to-k/cdk-local/issues/266)) ([2cd7f1f](https://github.com/go-to-k/cdk-local/commit/2cd7f1fefcd637bde933e5fb26952b53c44bd709))

## [0.73.5](https://github.com/go-to-k/cdk-local/compare/v0.73.4...v0.73.5) (2026-06-01)


### Bug Fixes

* **image-override:** re-build covered overrides on --watch reload so source edits propagate ([#263](https://github.com/go-to-k/cdk-local/issues/263)) ([95c64fe](https://github.com/go-to-k/cdk-local/commit/95c64fe100c4190a30b49c1a039ec72a61cac718))

## [0.73.4](https://github.com/go-to-k/cdk-local/compare/v0.73.3...v0.73.4) (2026-06-01)


### Bug Fixes

* **image-override:** tilde-expand paths + better boot-prompt UX (explain + Dockerfile picker) ([#261](https://github.com/go-to-k/cdk-local/issues/261)) ([5c3592c](https://github.com/go-to-k/cdk-local/commit/5c3592c223e9000bff3756fc291e639090952170))

## [0.73.3](https://github.com/go-to-k/cdk-local/compare/v0.73.2...v0.73.3) (2026-06-01)


### Bug Fixes

* **cli:** fully wire --profile across all STSClient sites + drop the misleading --region deprecation copy ([#254](https://github.com/go-to-k/cdk-local/issues/254)) ([13eb5a7](https://github.com/go-to-k/cdk-local/commit/13eb5a714bf8945b0d3e780e4c2076e109d15af6))

## [0.73.2](https://github.com/go-to-k/cdk-local/compare/v0.73.1...v0.73.2) (2026-06-01)


### Bug Fixes

* **local-dev:** surface auth / watcher / HTTPv2 / classifier rejection reasons (no more silent debug-log fallbacks) ([#253](https://github.com/go-to-k/cdk-local/issues/253)) ([7ad06b8](https://github.com/go-to-k/cdk-local/commit/7ad06b8191d2e92f65d343bb6db485b663388e2b))

## [0.73.1](https://github.com/go-to-k/cdk-local/compare/v0.73.0...v0.73.1) (2026-06-01)


### Bug Fixes

* **auth:** per-time-window dedup for "discovery unreachable -> token accepted" warns (was: silent accept for the rest of the session) ([#252](https://github.com/go-to-k/cdk-local/issues/252)) ([3d137fd](https://github.com/go-to-k/cdk-local/commit/3d137fdf500ace49a27b1008983b07252e2be30d))

# [0.73.0](https://github.com/go-to-k/cdk-local/compare/v0.72.0...v0.73.0) (2026-06-01)


### Features

* **image-override:** per-service variants of build-arg / build-secret / target ([#244](https://github.com/go-to-k/cdk-local/issues/244)) ([6875eeb](https://github.com/go-to-k/cdk-local/commit/6875eebe6d5f49c3446dae361d6346885e98f50b))

# [0.72.0](https://github.com/go-to-k/cdk-local/compare/v0.71.2...v0.72.0) (2026-05-31)


### Features

* **start-service,start-alb:** --image-override family + TTY boot prompt for pinned images ([#241](https://github.com/go-to-k/cdk-local/issues/241)) ([b45af54](https://github.com/go-to-k/cdk-local/commit/b45af543b751a242f7e79d5197fe223dc5b36e73))

## [0.71.2](https://github.com/go-to-k/cdk-local/compare/v0.71.1...v0.71.2) (2026-05-31)


### Bug Fixes

* **start-service,start-alb:** warn + skip noop --watch when image is pinned to a deployed registry ([#237](https://github.com/go-to-k/cdk-local/issues/237)) ([ac500c4](https://github.com/go-to-k/cdk-local/commit/ac500c4a9c34e1cee6ccebb91929b949c0d481d6))

## [0.71.1](https://github.com/go-to-k/cdk-local/compare/v0.71.0...v0.71.1) (2026-05-31)


### Bug Fixes

* **source-change-classifier:** default TypeScript edits to rebuild (precompile setups left stale by soft-reload) ([#236](https://github.com/go-to-k/cdk-local/issues/236)) ([40144df](https://github.com/go-to-k/cdk-local/commit/40144df94baec147b0a294b31d78598f2910c6f6))

# [0.71.0](https://github.com/go-to-k/cdk-local/compare/v0.70.0...v0.71.0) (2026-05-31)


### Features

* **start-service / start-alb:** stream replica container stdout/stderr live to host terminal ([#231](https://github.com/go-to-k/cdk-local/issues/231)) ([3d581d2](https://github.com/go-to-k/cdk-local/commit/3d581d210c86903a8836d7f736b64794f0ba5390))

# [0.70.0](https://github.com/go-to-k/cdk-local/compare/v0.69.0...v0.70.0) (2026-05-31)


### Features

* **start-alb:** explain which fields were evaluated in the no-rule-matched 404 ([#229](https://github.com/go-to-k/cdk-local/issues/229)) ([54d5505](https://github.com/go-to-k/cdk-local/commit/54d55055f36103303a38c1ec686a5a54f7a9602d))

# [0.69.0](https://github.com/go-to-k/cdk-local/compare/v0.68.0...v0.69.0) (2026-05-31)


### Features

* **start-service, start-alb:** bind-mount source fast path for `--watch` (Phase 4 of [#214](https://github.com/go-to-k/cdk-local/issues/214)) ([#219](https://github.com/go-to-k/cdk-local/issues/219)) ([1222c13](https://github.com/go-to-k/cdk-local/commit/1222c13406925471c61714ab4783a3b8b5b50553))

# [0.68.0](https://github.com/go-to-k/cdk-local/compare/v0.67.0...v0.68.0) (2026-05-31)


### Features

* **start-alb:** add `--watch` hot reload (Phase 3 of [#214](https://github.com/go-to-k/cdk-local/issues/214)) ([#217](https://github.com/go-to-k/cdk-local/issues/217)) ([938e922](https://github.com/go-to-k/cdk-local/commit/938e92232bf52535fe2edff454a6c7037aa51a9c))

# [0.67.0](https://github.com/go-to-k/cdk-local/compare/v0.66.0...v0.67.0) (2026-05-31)


### Features

* **start-service:** multi-replica rolling deploy for `--watch` (Phase 2 of [#214](https://github.com/go-to-k/cdk-local/issues/214)) ([#216](https://github.com/go-to-k/cdk-local/issues/216)) ([196afd6](https://github.com/go-to-k/cdk-local/commit/196afd662e0f7402a5fd958bab6a2d47a95dbe6e))

# [0.66.0](https://github.com/go-to-k/cdk-local/compare/v0.65.3...v0.66.0) (2026-05-31)


### Features

* **start-service:** add `--watch` hot reload (Phase 1 of [#214](https://github.com/go-to-k/cdk-local/issues/214)) ([#215](https://github.com/go-to-k/cdk-local/issues/215)) ([619feca](https://github.com/go-to-k/cdk-local/commit/619feca304d3950d46c05242f2df3cab5e2a1cdb))

## [0.65.3](https://github.com/go-to-k/cdk-local/compare/v0.65.2...v0.65.3) (2026-05-30)


### Bug Fixes

* **synth,resolvers:** accept pre-synth assemblies with missing context; surface state-load failure detail; drop hardcoded command names ([#211](https://github.com/go-to-k/cdk-local/issues/211)) ([c9511da](https://github.com/go-to-k/cdk-local/commit/c9511da17381f75ce870aa603d14ee9099f7894c))

## [0.65.2](https://github.com/go-to-k/cdk-local/compare/v0.65.1...v0.65.2) (2026-05-30)


### Bug Fixes

* **cdkd-parity-gate:** also trigger on new `.ts` files under `src/local/**` ([#208](https://github.com/go-to-k/cdk-local/issues/208)) ([1536f8d](https://github.com/go-to-k/cdk-local/commit/1536f8d22126a12d4dac46f2f6966f5e5212d220))

## [0.65.1](https://github.com/go-to-k/cdk-local/compare/v0.65.0...v0.65.1) (2026-05-30)


### Bug Fixes

* **start-alb,start-service:** drop stale "deferred to a follow-up PR" LB warning ([#206](https://github.com/go-to-k/cdk-local/issues/206)) ([79309ef](https://github.com/go-to-k/cdk-local/commit/79309ef6bfcb61aa39bf843a77379e1333e9bf8c))

# [0.65.0](https://github.com/go-to-k/cdk-local/compare/v0.64.0...v0.65.0) (2026-05-30)


### Features

* **cli:** extract `add<Cmd>SpecificOptions` helpers for the remaining 5 commands ([#200](https://github.com/go-to-k/cdk-local/issues/200)) ([#205](https://github.com/go-to-k/cdk-local/issues/205)) ([80699a1](https://github.com/go-to-k/cdk-local/commit/80699a1b5b7fc15b2f469bfce5cb52429c5baabd))
* **meta:** `/check-cdkd-parity` skill + markgate gate ([#201](https://github.com/go-to-k/cdk-local/issues/201)) ([#204](https://github.com/go-to-k/cdk-local/issues/204)) ([09296b6](https://github.com/go-to-k/cdk-local/commit/09296b67d8da0f9f78cd4fa62027dda38be70edd))

# [0.64.0](https://github.com/go-to-k/cdk-local/compare/v0.63.0...v0.64.0) (2026-05-30)


### Features

* **start-alb:** serve cloud-HTTPS listeners over plain HTTP by default; gate real TLS behind `--tls` ([#203](https://github.com/go-to-k/cdk-local/issues/203)) ([c9f0ff4](https://github.com/go-to-k/cdk-local/commit/c9f0ff4fb2edbae8e85294b37185a0abcbd4c744))

# [0.63.0](https://github.com/go-to-k/cdk-local/compare/v0.62.1...v0.63.0) (2026-05-30)


### Features

* **start-service,start-alb:** surface a Service endpoints: banner at end of boot ([#199](https://github.com/go-to-k/cdk-local/issues/199)) ([54c1be6](https://github.com/go-to-k/cdk-local/commit/54c1be62da680ffdfa8c99e51f7882efd85df1f5))

## [0.62.1](https://github.com/go-to-k/cdk-local/compare/v0.62.0...v0.62.1) (2026-05-30)


### Bug Fixes

* **invoke-agentcore:** resolve bare --assume-role for same-stack Runtime exec roles ([#194](https://github.com/go-to-k/cdk-local/issues/194)) ([75451c9](https://github.com/go-to-k/cdk-local/commit/75451c9c8145f87dc06bcd2b77e0b40bd6ef1a8e))

# [0.62.0](https://github.com/go-to-k/cdk-local/compare/v0.61.1...v0.62.0) (2026-05-30)


### Features

* **exports:** expose ecs-service-emulator + elb-front-door-resolver for shim consumers ([#190](https://github.com/go-to-k/cdk-local/issues/190)) ([ae00db8](https://github.com/go-to-k/cdk-local/commit/ae00db80271ddbbd5996799f627ad6646ba89ca3))

## [0.61.1](https://github.com/go-to-k/cdk-local/compare/v0.61.0...v0.61.1) (2026-05-30)


### Bug Fixes

* **invoke:** resolve bare --assume-role from GetFunctionConfiguration ([#185](https://github.com/go-to-k/cdk-local/issues/185)) ([0623a1a](https://github.com/go-to-k/cdk-local/commit/0623a1ad54554d6c09ffc988d39ffd28ff8f214c))

# [0.61.0](https://github.com/go-to-k/cdk-local/compare/v0.60.0...v0.61.0) (2026-05-30)


### Features

* **exports:** expose pickAgentCoreCandidateStack + resolveSingleTarget for shim consumers ([#177](https://github.com/go-to-k/cdk-local/issues/177)) ([b799b78](https://github.com/go-to-k/cdk-local/commit/b799b78a384f8078a37f0a82818d1bd6e8af7a9e))

# [0.60.0](https://github.com/go-to-k/cdk-local/compare/v0.59.0...v0.60.0) (2026-05-30)


### Features

* **start-alb:** proxy WebSocket Upgrade to ECS forward targets ([#176](https://github.com/go-to-k/cdk-local/issues/176)) ([f591110](https://github.com/go-to-k/cdk-local/commit/f591110f26a902832f896681ef7cbf1425e03ba7))

# [0.59.0](https://github.com/go-to-k/cdk-local/compare/v0.58.0...v0.59.0) (2026-05-30)


### Features

* **start-alb:** enforce authenticate-cognito / authenticate-oidc locally ([#174](https://github.com/go-to-k/cdk-local/issues/174)) ([e5b8b5b](https://github.com/go-to-k/cdk-local/commit/e5b8b5be119a28b1ec430eb060d9dec5677222cb))

# [0.58.0](https://github.com/go-to-k/cdk-local/compare/v0.57.0...v0.58.0) (2026-05-30)


### Features

* **invoke-agentcore:** support A2A + AGUI protocols locally ([#175](https://github.com/go-to-k/cdk-local/issues/175)) ([ca5dea9](https://github.com/go-to-k/cdk-local/commit/ca5dea9067b4e8e82cd9481f8c7b0ce6b41fbd6b))

# [0.57.0](https://github.com/go-to-k/cdk-local/compare/v0.56.0...v0.57.0) (2026-05-30)


### Features

* **invoke-agentcore:** precise --from-cfn-stack hint for same-stack ECR ContainerUri ([#173](https://github.com/go-to-k/cdk-local/issues/173)) ([0b3269c](https://github.com/go-to-k/cdk-local/commit/0b3269c760ec7cb633e1e064eb3600e9b89c57a6))

# [0.56.0](https://github.com/go-to-k/cdk-local/compare/v0.55.0...v0.56.0) (2026-05-30)


### Features

* **invoke-agentcore:** `--ws-interactive` REPL mode for --ws ([#172](https://github.com/go-to-k/cdk-local/issues/172)) ([444ae0b](https://github.com/go-to-k/cdk-local/commit/444ae0bd12eb3006bc2b8edafaafb5224bf7762e))

# [0.55.0](https://github.com/go-to-k/cdk-local/compare/v0.54.0...v0.55.0) (2026-05-30)


### Features

* **start-alb:** terminate HTTPS listeners locally with BYO or auto self-signed cert ([#169](https://github.com/go-to-k/cdk-local/issues/169)) ([4722f6a](https://github.com/go-to-k/cdk-local/commit/4722f6a2f7d423e974e214316eb5104b05261879))

# [0.54.0](https://github.com/go-to-k/cdk-local/compare/v0.53.0...v0.54.0) (2026-05-30)


### Features

* **invoke-agentcore:** `--timeout <ms>` flag (default 120000) ([#171](https://github.com/go-to-k/cdk-local/issues/171)) ([5ec7f1a](https://github.com/go-to-k/cdk-local/commit/5ec7f1aec59883bcdcd59101c8faa527669e2f7b))

# [0.53.0](https://github.com/go-to-k/cdk-local/compare/v0.52.0...v0.53.0) (2026-05-30)


### Features

* **invoke-agentcore:** --sigv4 opt-in inbound SigV4 signing ([#167](https://github.com/go-to-k/cdk-local/issues/167)) ([0e845f1](https://github.com/go-to-k/cdk-local/commit/0e845f15cac4de05f937e6d8f6d1a1c61ca57cb4))

# [0.52.0](https://github.com/go-to-k/cdk-local/compare/v0.51.0...v0.52.0) (2026-05-30)


### Features

* **invoke-agentcore:** verify customJwtAuthorizer allowedScopes + customClaims ([#166](https://github.com/go-to-k/cdk-local/issues/166)) ([f4bff48](https://github.com/go-to-k/cdk-local/commit/f4bff4800859d32644b7648cfc67e6ad219c5024))

# [0.51.0](https://github.com/go-to-k/cdk-local/compare/v0.50.0...v0.51.0) (2026-05-30)


### Features

* **start-alb:** honor http-header / http-request-method / query-string / source-ip listener-rule conditions ([#159](https://github.com/go-to-k/cdk-local/issues/159)) ([0e3259a](https://github.com/go-to-k/cdk-local/commit/0e3259ab484747d53d48e64089963667e01f16a7))

# [0.50.0](https://github.com/go-to-k/cdk-local/compare/v0.49.0...v0.50.0) (2026-05-30)


### Features

* **invoke-agentcore:** resolve intrinsic Code.S3.Bucket for fromS3 under --from-cfn-stack ([#158](https://github.com/go-to-k/cdk-local/issues/158)) ([fb11a01](https://github.com/go-to-k/cdk-local/commit/fb11a01e16dcee7b57bbf2bcd63c37f83ebd41b7))

# [0.49.0](https://github.com/go-to-k/cdk-local/compare/v0.48.0...v0.49.0) (2026-05-29)


### Features

* **invoke-agentcore:** support fromS3 CodeConfiguration bundles ([#156](https://github.com/go-to-k/cdk-local/issues/156)) ([9a271f2](https://github.com/go-to-k/cdk-local/commit/9a271f229e0833b78920b3e75d472440b7d91690))

# [0.48.0](https://github.com/go-to-k/cdk-local/compare/v0.47.0...v0.48.0) (2026-05-29)

# [0.47.0](https://github.com/go-to-k/cdk-local/compare/v0.46.0...v0.47.0) (2026-05-29)


### Features

* **invoke-agentcore:** stream over the agent /ws WebSocket with --ws ([#154](https://github.com/go-to-k/cdk-local/issues/154)) ([4791d28](https://github.com/go-to-k/cdk-local/commit/4791d28119e1a4a363fa3a5fe9ee3f3dc67de5c7))

# [0.46.0](https://github.com/go-to-k/cdk-local/compare/v0.45.0...v0.46.0) (2026-05-29)


### Features

* **invoke-agentcore:** deepen --from-cfn-stack + credential parity ([#149](https://github.com/go-to-k/cdk-local/issues/149)) ([6c4edc5](https://github.com/go-to-k/cdk-local/commit/6c4edc59c330a79aae4a98f99433218cc592b4b1))

# [0.45.0](https://github.com/go-to-k/cdk-local/compare/v0.44.0...v0.45.0) (2026-05-29)


### Features

* **start-alb:** ALB -> Lambda targets ([#148](https://github.com/go-to-k/cdk-local/issues/148)) ([94a39e4](https://github.com/go-to-k/cdk-local/commit/94a39e4dd8d36546971f012041cb3ed6ccb8dde8))

# [0.44.0](https://github.com/go-to-k/cdk-local/compare/v0.43.0...v0.44.0) (2026-05-29)


### Features

* **start-alb:** host-header + weighted forward + redirect/fixed-response routing ([#146](https://github.com/go-to-k/cdk-local/issues/146)) ([8987f99](https://github.com/go-to-k/cdk-local/commit/8987f9901e36909912330e795d77a5308fc687aa))

# [0.43.0](https://github.com/go-to-k/cdk-local/compare/v0.42.0...v0.43.0) (2026-05-29)


### Features

* **invoke-agentcore:** run CodeConfiguration (managed-runtime) artifacts from source ([#145](https://github.com/go-to-k/cdk-local/issues/145)) ([31fdcd5](https://github.com/go-to-k/cdk-local/commit/31fdcd505999cb5e2016989fed2c572d5e3ecb90))

# [0.42.0](https://github.com/go-to-k/cdk-local/compare/v0.41.0...v0.42.0) (2026-05-29)


### Features

* **invoke-agentcore:** run MCP-protocol runtimes locally (POST /mcp) ([#142](https://github.com/go-to-k/cdk-local/issues/142)) ([9643780](https://github.com/go-to-k/cdk-local/commit/96437808fa70a84c924622353f97a47a808788ad))

# [0.41.0](https://github.com/go-to-k/cdk-local/compare/v0.40.0...v0.41.0) (2026-05-29)


### Features

* **hooks:** control-char-gate — block NUL / control bytes in staged text ([#141](https://github.com/go-to-k/cdk-local/issues/141)) ([7669377](https://github.com/go-to-k/cdk-local/commit/76693777f7df50b29a4903c235445076f4d65335))

# [0.40.0](https://github.com/go-to-k/cdk-local/compare/v0.39.0...v0.40.0) (2026-05-29)


### Features

* **start-alb:** ALB path-pattern listener-rule routing across backing services ([#139](https://github.com/go-to-k/cdk-local/issues/139)) ([131921b](https://github.com/go-to-k/cdk-local/commit/131921bdd5eb55e2038d40c612d94db99874a84a))

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
