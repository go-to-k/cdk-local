## [0.146.1](https://github.com/go-to-k/cdk-local/compare/v0.146.0...v0.146.1) (2026-06-08)


### Bug Fixes

* **start-alb:** emit listener warnings once, not "WARN:   WARN:" + repair the alb-https integ fixture ([#488](https://github.com/go-to-k/cdk-local/issues/488)) ([a71ea57](https://github.com/go-to-k/cdk-local/commit/a71ea5796f65eb26159865efef51f69c57aa6706))

# [0.146.0](https://github.com/go-to-k/cdk-local/compare/v0.145.0...v0.146.0) (2026-06-08)


### Features

* **hooks:** force worktree PR merges through /merge-pr via a markgate gate ([#487](https://github.com/go-to-k/cdk-local/issues/487)) ([49f192c](https://github.com/go-to-k/cdk-local/commit/49f192ca9fffc408a866baab2c42979f70ff0544))

# [0.145.0](https://github.com/go-to-k/cdk-local/compare/v0.144.1...v0.145.0) (2026-06-08)


### Features

* **studio:** make the "Started with" summary collapsible (open by default) ([#486](https://github.com/go-to-k/cdk-local/issues/486)) ([b0bfd4e](https://github.com/go-to-k/cdk-local/commit/b0bfd4e584a331d95c602a1a877031bfcc960b3a))

## [0.144.1](https://github.com/go-to-k/cdk-local/compare/v0.144.0...v0.144.1) (2026-06-08)


### Bug Fixes

* **start-service:** emit the same-stack-ECR boot WARN once, not twice ([#485](https://github.com/go-to-k/cdk-local/issues/485)) ([551fd0c](https://github.com/go-to-k/cdk-local/commit/551fd0c418e67b1302fc4a4eab985c0a5c5a01ae))

# [0.144.0](https://github.com/go-to-k/cdk-local/compare/v0.143.3...v0.144.0) (2026-06-08)


### Features

* **docker:** reach the host via host.docker.internal on invoke/run-task/ECS runs ([#483](https://github.com/go-to-k/cdk-local/issues/483)) ([4b957f4](https://github.com/go-to-k/cdk-local/commit/4b957f44d9e7944f13305b0dee7475cafff7ec61))

## [0.143.3](https://github.com/go-to-k/cdk-local/compare/v0.143.2...v0.143.3) (2026-06-08)


### Bug Fixes

* **studio:** point users to --from-cfn-stack when an ECS image can't be pin-classified ([#484](https://github.com/go-to-k/cdk-local/issues/484)) ([b581741](https://github.com/go-to-k/cdk-local/commit/b5817419959e84bfb975c463e23ee338ba8f5fc8))

## [0.143.2](https://github.com/go-to-k/cdk-local/compare/v0.143.1...v0.143.2) (2026-06-08)


### Bug Fixes

* **studio:** readability/color pass on the embedded UI + amber image-override prominence ([#480](https://github.com/go-to-k/cdk-local/issues/480)) ([342fcd3](https://github.com/go-to-k/cdk-local/commit/342fcd3977f379d80dfd0d1cc498a26caa39f5b8))

## [0.143.1](https://github.com/go-to-k/cdk-local/compare/v0.143.0...v0.143.1) (2026-06-08)


### Bug Fixes

* **studio:** expose the image-override build-input flags as "All options" controls ([#479](https://github.com/go-to-k/cdk-local/issues/479)) ([0259083](https://github.com/go-to-k/cdk-local/commit/0259083979c4b45f01cbf376ecd00c8d07994e73))

# [0.143.0](https://github.com/go-to-k/cdk-local/compare/v0.142.0...v0.143.0) (2026-06-07)


### Features

* **logger:** prefix warn/error with WARN:/ERROR: + colour studio LOGS by level ([#478](https://github.com/go-to-k/cdk-local/issues/478)) ([bcdd00d](https://github.com/go-to-k/cdk-local/commit/bcdd00d0cac85433470aa87967be44b55e9f117d))


### Reverts

* undici keep-alive minimization (disproven [#402](https://github.com/go-to-k/cdk-local/issues/402) crash fix) ([#477](https://github.com/go-to-k/cdk-local/issues/477)) ([b6a70e0](https://github.com/go-to-k/cdk-local/commit/b6a70e0518df434e4090eca66ea032912582e340))

# [0.142.0](https://github.com/go-to-k/cdk-local/compare/v0.141.0...v0.142.0) (2026-06-07)


### Features

* **start-cloudfront:** WARN when --cache-origin is set without --from-cfn-stack ([#476](https://github.com/go-to-k/cdk-local/issues/476)) ([8015335](https://github.com/go-to-k/cdk-local/commit/80153350f14251289ffb359e4b0fcd0834a2f59a))

# [0.141.0](https://github.com/go-to-k/cdk-local/compare/v0.140.0...v0.141.0) (2026-06-07)


### Features

* **studio:** auto-render editable controls for every flag in "All options" ([#472](https://github.com/go-to-k/cdk-local/issues/472)) ([038d3bc](https://github.com/go-to-k/cdk-local/commit/038d3bc66dcd2ba735f2731d9cfc3a9f8486af3d))

# [0.140.0](https://github.com/go-to-k/cdk-local/compare/v0.139.3...v0.140.0) (2026-06-07)


### Features

* **start-cloudfront:** accept a construct path / bare id for --kvs-file key ([#467](https://github.com/go-to-k/cdk-local/issues/467)) ([0447ac3](https://github.com/go-to-k/cdk-local/commit/0447ac3ddc6004abbd432d6a6727e64ff2176d77))

## [0.139.3](https://github.com/go-to-k/cdk-local/compare/v0.139.2...v0.139.3) (2026-06-06)


### Bug Fixes

* **studio:** selection highlight follows the clicked row, not its same-id twin ([#466](https://github.com/go-to-k/cdk-local/issues/466)) ([67a8bc5](https://github.com/go-to-k/cdk-local/commit/67a8bc590098cfbdeec57e87837e46b900f8c3ad))

## [0.139.2](https://github.com/go-to-k/cdk-local/compare/v0.139.1...v0.139.2) (2026-06-06)


### Bug Fixes

* **studio:** symmetric "(AgentCore)" row label across invoke/serve groups ([#464](https://github.com/go-to-k/cdk-local/issues/464)) ([e5d07d5](https://github.com/go-to-k/cdk-local/commit/e5d07d505d7c6bfb215d159260a06599917c3816))

## [0.139.1](https://github.com/go-to-k/cdk-local/compare/v0.139.0...v0.139.1) (2026-06-06)


### Bug Fixes

* **studio:** symmetric AgentCore (invoke)/(serve) group names + drop dead invoke row button ([#463](https://github.com/go-to-k/cdk-local/issues/463)) ([a80954d](https://github.com/go-to-k/cdk-local/commit/a80954d3278e1953b06ced13eeb8a62e65edcccf))

# [0.139.0](https://github.com/go-to-k/cdk-local/compare/v0.138.0...v0.139.0) (2026-06-06)


### Features

* **start-agentcore:** --watch reloads the warm container in place ([#454](https://github.com/go-to-k/cdk-local/issues/454) slice 4b) ([#462](https://github.com/go-to-k/cdk-local/issues/462)) ([782a09d](https://github.com/go-to-k/cdk-local/commit/782a09dc0d42193f814e8aca5b0016a323e827b1))

# [0.138.0](https://github.com/go-to-k/cdk-local/compare/v0.137.0...v0.138.0) (2026-06-06)


### Features

* **start-agentcore:** per-request inbound JWT + --sigv4 on the warm serve ([#454](https://github.com/go-to-k/cdk-local/issues/454) slice 4a) ([#461](https://github.com/go-to-k/cdk-local/issues/461)) ([9582920](https://github.com/go-to-k/cdk-local/commit/9582920197e2ae92ef9707e077b5625efdfe54ac))

# [0.137.0](https://github.com/go-to-k/cdk-local/compare/v0.136.0...v0.137.0) (2026-06-06)


### Features

* **studio:** warm-serve AgentCore HTTP composer + list all protocols ([#454](https://github.com/go-to-k/cdk-local/issues/454) slice 3) ([#460](https://github.com/go-to-k/cdk-local/issues/460)) ([4d97315](https://github.com/go-to-k/cdk-local/commit/4d973150f6b058243f38d0315f8f1f715d805696))

# [0.136.0](https://github.com/go-to-k/cdk-local/compare/v0.135.0...v0.136.0) (2026-06-06)


### Features

* **start-agentcore:** serve MCP + A2A warm, alongside HTTP/AGUI ([#454](https://github.com/go-to-k/cdk-local/issues/454) slice 2) ([#459](https://github.com/go-to-k/cdk-local/issues/459)) ([d4d93bd](https://github.com/go-to-k/cdk-local/commit/d4d93bd1dcf80338f31ebe9b3948af644115d1c0))

# [0.135.0](https://github.com/go-to-k/cdk-local/compare/v0.134.1...v0.135.0) (2026-06-06)


### Features

* **start-agentcore:** warm HTTP serve — POST /invocations + GET /ping on the live container ([#454](https://github.com/go-to-k/cdk-local/issues/454) slice 1) ([#458](https://github.com/go-to-k/cdk-local/issues/458)) ([c30e74a](https://github.com/go-to-k/cdk-local/commit/c30e74af6baecff5e2070d8d74bd46f6a62a4e5a))

## [0.134.1](https://github.com/go-to-k/cdk-local/compare/v0.134.0...v0.134.1) (2026-06-06)


### Bug Fixes

* **invoke-agentcore:** don't install deps for CodeConfiguration builds; warn to vendor ([#456](https://github.com/go-to-k/cdk-local/issues/456)) ([7e49b29](https://github.com/go-to-k/cdk-local/commit/7e49b29d8f70f925defe8ee1bc1c1f48d8af4ad7))

# [0.134.0](https://github.com/go-to-k/cdk-local/compare/v0.133.0...v0.134.0) (2026-06-06)


### Features

* **studio:** label targets-pane rows by API surface + "ECS Service" ([#453](https://github.com/go-to-k/cdk-local/issues/453)) ([884d585](https://github.com/go-to-k/cdk-local/commit/884d58563bc85465674f415d1b23d83b8159b683))

# [0.133.0](https://github.com/go-to-k/cdk-local/compare/v0.132.2...v0.133.0) (2026-06-05)


### Features

* **studio:** surface the watch + assume-role session toggles ([#452](https://github.com/go-to-k/cdk-local/issues/452)) ([373984f](https://github.com/go-to-k/cdk-local/commit/373984f883d7daca28a58c052f270ae2edaa3850))

## [0.132.2](https://github.com/go-to-k/cdk-local/compare/v0.132.1...v0.132.2) (2026-06-05)


### Bug Fixes

* **integ:** restore the docker sweep in local-run-task-multi-container cleanup ([#451](https://github.com/go-to-k/cdk-local/issues/451)) ([def2279](https://github.com/go-to-k/cdk-local/commit/def22795198eef812d62950af41a88574a73cc9c))

## [0.132.1](https://github.com/go-to-k/cdk-local/compare/v0.132.0...v0.132.1) (2026-06-05)


### Bug Fixes

* **studio:** rename the targets-pane ALB group to "Application Load Balancers" ([#449](https://github.com/go-to-k/cdk-local/issues/449)) ([07d482c](https://github.com/go-to-k/cdk-local/commit/07d482cb0d0bb06083521705565aaf4599b2c9fc))

# [0.132.0](https://github.com/go-to-k/cdk-local/compare/v0.131.1...v0.132.0) (2026-06-05)


### Features

* **studio:** colour-code the serve workspace headings (yellow output sections, blue structural labels) ([#447](https://github.com/go-to-k/cdk-local/issues/447)) ([5516cd0](https://github.com/go-to-k/cdk-local/commit/5516cd0ea1995033ddbb53cc6fa8394bbbb49b1c))

## [0.131.1](https://github.com/go-to-k/cdk-local/compare/v0.131.0...v0.131.1) (2026-06-05)


### Bug Fixes

* **studio:** drop bold on the kind-group header label ([#446](https://github.com/go-to-k/cdk-local/issues/446)) ([7a07a2a](https://github.com/go-to-k/cdk-local/commit/7a07a2af16d8496d663ae501fa3042034f2f8add))

# [0.131.0](https://github.com/go-to-k/cdk-local/compare/v0.130.3...v0.131.0) (2026-06-05)


### Features

* **studio:** emphasise the composer result's Request/Response headings + distinct Headers/Body sub-labels ([#444](https://github.com/go-to-k/cdk-local/issues/444)) ([c5cf834](https://github.com/go-to-k/cdk-local/commit/c5cf834f208e09d278238f6fb69ad46a3e59e30a))

## [0.130.3](https://github.com/go-to-k/cdk-local/compare/v0.130.2...v0.130.3) (2026-06-05)


### Bug Fixes

* **studio:** translucent amber kind-group header + size hierarchy ([#443](https://github.com/go-to-k/cdk-local/issues/443)) ([139ed7a](https://github.com/go-to-k/cdk-local/commit/139ed7ab68972edb9a7df58831ae27f7ac2389aa))

## [0.130.2](https://github.com/go-to-k/cdk-local/compare/v0.130.1...v0.130.2) (2026-06-05)


### Bug Fixes

* **invoke:** correct the emulation warn message (drop the misattributed Swift/illegal-instruction example) ([#442](https://github.com/go-to-k/cdk-local/issues/442)) ([92c51ff](https://github.com/go-to-k/cdk-local/commit/92c51ff87203bc6e64d6a9b3c530b61b97d13b58))

## [0.130.1](https://github.com/go-to-k/cdk-local/compare/v0.130.0...v0.130.1) (2026-06-05)


### Bug Fixes

* **studio:** put the WS console Connect button on its own row above the input ([#441](https://github.com/go-to-k/cdk-local/issues/441)) ([4502ea4](https://github.com/go-to-k/cdk-local/commit/4502ea4c5b28cb08bdb36b7f788d737b425d1e4d))

# [0.130.0](https://github.com/go-to-k/cdk-local/compare/v0.129.1...v0.130.0) (2026-06-05)


### Features

* **invoke/run-task:** warn when a Lambda/ECS container runs under CPU emulation ([#440](https://github.com/go-to-k/cdk-local/issues/440)) ([08d9feb](https://github.com/go-to-k/cdk-local/commit/08d9febc7f4f4b530e29b9bbb5ad91c45937d358))

## [0.129.1](https://github.com/go-to-k/cdk-local/compare/v0.129.0...v0.129.1) (2026-06-05)


### Bug Fixes

* **studio:** full-width WS input, wrap Send below, right-aligned Clear above the log ([#439](https://github.com/go-to-k/cdk-local/issues/439)) ([cd37a02](https://github.com/go-to-k/cdk-local/commit/cd37a021fec5edcdaa0e930e2ca044d7d2496339))

# [0.129.0](https://github.com/go-to-k/cdk-local/compare/v0.128.1...v0.129.0) (2026-06-05)


### Features

* **studio:** show the composer result as a Request/Response pair with split headers/body + JSON pretty-print ([#438](https://github.com/go-to-k/cdk-local/issues/438)) ([06e9cae](https://github.com/go-to-k/cdk-local/commit/06e9cae53d1e5b7203bdd63e5ec1fa19bfcf32fd))

## [0.128.1](https://github.com/go-to-k/cdk-local/compare/v0.128.0...v0.128.1) (2026-06-05)


### Bug Fixes

* **studio:** switch the kind-group header bar to a warm amber tint ([#437](https://github.com/go-to-k/cdk-local/issues/437)) ([2a53f41](https://github.com/go-to-k/cdk-local/commit/2a53f413c76a8745f4ec414a168cb8b8c7107c94))

# [0.128.0](https://github.com/go-to-k/cdk-local/compare/v0.127.3...v0.128.0) (2026-06-05)


### Features

* **start-cloudfront:** accept extraStateProviders on the command factory (host --from-state parity) ([#436](https://github.com/go-to-k/cdk-local/issues/436)) ([fb0fefc](https://github.com/go-to-k/cdk-local/commit/fb0fefcdf8317569fd0e9d4e5efdb5e8479af6da))

## [0.127.3](https://github.com/go-to-k/cdk-local/compare/v0.127.2...v0.127.3) (2026-06-05)


### Bug Fixes

* **studio:** give the kind-group headers a uniform light-grey bar background ([#435](https://github.com/go-to-k/cdk-local/issues/435)) ([7693c85](https://github.com/go-to-k/cdk-local/commit/7693c85d2191f2d6c2a6ca7bb5ade78010a9f45b))

## [0.127.2](https://github.com/go-to-k/cdk-local/compare/v0.127.1...v0.127.2) (2026-06-05)


### Bug Fixes

* **invoke:** recreate symlink entries when extracting a ZIP-FILE Lambda asset ([#434](https://github.com/go-to-k/cdk-local/issues/434)) ([a4bd34f](https://github.com/go-to-k/cdk-local/commit/a4bd34fabc5355367143e94f31e3f98e0f4e9ced))

## [0.127.1](https://github.com/go-to-k/cdk-local/compare/v0.127.0...v0.127.1) (2026-06-05)


### Bug Fixes

* **studio:** cap WS console width + move Clear below the log, enlarge it ([#433](https://github.com/go-to-k/cdk-local/issues/433)) ([3e00a14](https://github.com/go-to-k/cdk-local/commit/3e00a14cd5b7a36cc576d02f8b124ea56f80e8d2))

# [0.127.0](https://github.com/go-to-k/cdk-local/compare/v0.126.6...v0.127.0) (2026-06-05)


### Features

* **studio:** frame the composer result as Response + capture ecs --host-port requests on the timeline ([#432](https://github.com/go-to-k/cdk-local/issues/432)) ([f5b6827](https://github.com/go-to-k/cdk-local/commit/f5b6827b93dacf08a8bb4a0520e3bd8445e09a92))

## [0.126.6](https://github.com/go-to-k/cdk-local/compare/v0.126.5...v0.126.6) (2026-06-05)


### Bug Fixes

* **deps:** bump @aws-cdk/toolkit-lib to ^1.28.0 for aws-cdk-lib 2.258.0 (schema v54) ([#431](https://github.com/go-to-k/cdk-local/issues/431)) ([4226591](https://github.com/go-to-k/cdk-local/commit/4226591902e3657d0a16aafcd7294d13f875096c))

## [0.126.5](https://github.com/go-to-k/cdk-local/compare/v0.126.4...v0.126.5) (2026-06-05)


### Bug Fixes

* **studio:** tint the folded stack sub-header blue so it never reads as a row ([#429](https://github.com/go-to-k/cdk-local/issues/429)) ([24494eb](https://github.com/go-to-k/cdk-local/commit/24494eb6b4b0b617cca73eb4c0e53bbedcf1ef21))

## [0.126.4](https://github.com/go-to-k/cdk-local/compare/v0.126.3...v0.126.4) (2026-06-05)


### Bug Fixes

* **invoke:** pin --platform to the Lambda architecture for ZIP functions (exec format error) ([#428](https://github.com/go-to-k/cdk-local/issues/428)) ([f3f9ddf](https://github.com/go-to-k/cdk-local/commit/f3f9ddfa411f077baf0859b7240acfe23c56d645))

## [0.126.3](https://github.com/go-to-k/cdk-local/compare/v0.126.2...v0.126.3) (2026-06-05)


### Bug Fixes

* **studio:** tie the UI live/disconnected indicator to its originating server ([#427](https://github.com/go-to-k/cdk-local/issues/427)) ([ac35726](https://github.com/go-to-k/cdk-local/commit/ac35726f60b36a659e11936110dd8b0c82a8cad7))

## [0.126.2](https://github.com/go-to-k/cdk-local/compare/v0.126.1...v0.126.2) (2026-06-05)


### Bug Fixes

* **studio:** make the folded stack sub-header legible on the dark pane ([#425](https://github.com/go-to-k/cdk-local/issues/425)) ([b7ec899](https://github.com/go-to-k/cdk-local/commit/b7ec899c076e9ea7e97a4589f98dca560c6b2d98))

## [0.126.1](https://github.com/go-to-k/cdk-local/compare/v0.126.0...v0.126.1) (2026-06-05)


### Bug Fixes

* **studio:** guard IME Enter + add Clear button in the WebSocket console ([#424](https://github.com/go-to-k/cdk-local/issues/424)) ([15fe362](https://github.com/go-to-k/cdk-local/commit/15fe362845e1fa1b941d0a0495052b983cc85c47))

# [0.126.0](https://github.com/go-to-k/cdk-local/compare/v0.125.0...v0.126.0) (2026-06-05)


### Features

* **studio:** interactive WebSocket console for AgentCore /ws (agentcore-ws serve kind) ([#422](https://github.com/go-to-k/cdk-local/issues/422)) ([d8befa0](https://github.com/go-to-k/cdk-local/commit/d8befa05bbab61d0645198da5af380c356934ced))

# [0.125.0](https://github.com/go-to-k/cdk-local/compare/v0.124.2...v0.125.0) (2026-06-05)


### Features

* **start-agentcore:** serve an AgentCore /ws endpoint via a host WebSocket bridge ([#420](https://github.com/go-to-k/cdk-local/issues/420)) ([33ed11e](https://github.com/go-to-k/cdk-local/commit/33ed11e883b81d9f027d3e6f5eebbbeba98cf57f))

## [0.124.2](https://github.com/go-to-k/cdk-local/compare/v0.124.1...v0.124.2) (2026-06-04)


### Bug Fixes

* **studio:** keep the Stop "Stopping..." affordance visible for a minimum window ([#421](https://github.com/go-to-k/cdk-local/issues/421)) ([1eebf0b](https://github.com/go-to-k/cdk-local/commit/1eebf0b0adcaf12c414fb3b32afb5e651ceb2bb7))

## [0.124.1](https://github.com/go-to-k/cdk-local/compare/v0.124.0...v0.124.1) (2026-06-04)


### Bug Fixes

* **invoke:** preserve the executable bit when extracting a ZIP-FILE Lambda asset ([#419](https://github.com/go-to-k/cdk-local/issues/419)) ([aea41fc](https://github.com/go-to-k/cdk-local/commit/aea41fcfa6eeb1b6c9b8913001e03a98c095c704))

# [0.124.0](https://github.com/go-to-k/cdk-local/compare/v0.123.3...v0.124.0) (2026-06-04)


### Features

* **studio:** fold per-stack construct-path prefix in the targets pane ([#418](https://github.com/go-to-k/cdk-local/issues/418)) ([b7eea9d](https://github.com/go-to-k/cdk-local/commit/b7eea9da214066411b9810e62d4aaa79fd7005dc))

## [0.123.3](https://github.com/go-to-k/cdk-local/compare/v0.123.2...v0.123.3) (2026-06-04)


### Bug Fixes

* **studio:** make the request-composer Send button green ([#417](https://github.com/go-to-k/cdk-local/issues/417)) ([62d6250](https://github.com/go-to-k/cdk-local/commit/62d6250dd133ad7ca64ea20338455f36c1621b3d))

## [0.123.2](https://github.com/go-to-k/cdk-local/compare/v0.123.1...v0.123.2) (2026-06-04)


### Bug Fixes

* **logger:** only emit ANSI color when output is a TTY (NO_COLOR / FORCE_COLOR aware) ([#416](https://github.com/go-to-k/cdk-local/issues/416)) ([eedecce](https://github.com/go-to-k/cdk-local/commit/eedecce48ea540b9f3b9a6acbeb7f1669cb5974b))

## [0.123.1](https://github.com/go-to-k/cdk-local/compare/v0.123.0...v0.123.1) (2026-06-04)


### Bug Fixes

* **invoke:** extract a ZIP-FILE Lambda asset before bind-mounting ([#415](https://github.com/go-to-k/cdk-local/issues/415)) ([e9dd2a2](https://github.com/go-to-k/cdk-local/commit/e9dd2a244fad5c844551e996b2b05cfe00128d44))

# [0.123.0](https://github.com/go-to-k/cdk-local/compare/v0.122.0...v0.123.0) (2026-06-04)


### Features

* **start-cloudfront:** resolve an external / non-CDK S3 origin bucket (DomainName parse + GetDistributionConfig) ([#405](https://github.com/go-to-k/cdk-local/issues/405) follow-up) ([#413](https://github.com/go-to-k/cdk-local/issues/413)) ([426dc65](https://github.com/go-to-k/cdk-local/commit/426dc65dc65b6931d3ab9e939282f350b781a893))

# [0.122.0](https://github.com/go-to-k/cdk-local/compare/v0.121.1...v0.122.0) (2026-06-04)


### Features

* **start-cloudfront:** --cache-origin read-through cache for the deployed-S3 origin ([#405](https://github.com/go-to-k/cdk-local/issues/405) follow-up) ([#412](https://github.com/go-to-k/cdk-local/issues/412)) ([cd7ad03](https://github.com/go-to-k/cdk-local/commit/cd7ad033eeb6f7cf0766c532ea07782b5e28fdd3))

## [0.121.1](https://github.com/go-to-k/cdk-local/compare/v0.121.0...v0.121.1) (2026-06-04)


### Bug Fixes

* **start-cloudfront:** expose the CloudFront-Functions-2.0 runtime built-ins (Buffer, crypto, ...) in the vm sandbox ([#411](https://github.com/go-to-k/cdk-local/issues/411)) ([b77daa1](https://github.com/go-to-k/cdk-local/commit/b77daa173398b3b30c04fcb774f004e27ef27005))

# [0.121.0](https://github.com/go-to-k/cdk-local/compare/v0.120.0...v0.121.0) (2026-06-04)


### Features

* **start-cloudfront:** serve an S3 origin from real S3 on demand under --from-cfn-stack ([#405](https://github.com/go-to-k/cdk-local/issues/405)) ([#409](https://github.com/go-to-k/cdk-local/issues/409)) ([7c98f05](https://github.com/go-to-k/cdk-local/commit/7c98f057eedd60b484e7c7eefdf13d8e176b3ee1))

# [0.120.0](https://github.com/go-to-k/cdk-local/compare/v0.119.0...v0.120.0) (2026-06-04)


### Features

* **start-cloudfront:** run Lambda@Edge functions locally (LambdaFunctionAssociations) ([#408](https://github.com/go-to-k/cdk-local/issues/408)) ([6946c68](https://github.com/go-to-k/cdk-local/commit/6946c689ecf18dae0337254d1bdd4654b25a7b17))

# [0.119.0](https://github.com/go-to-k/cdk-local/compare/v0.118.1...v0.119.0) (2026-06-04)


### Features

* **start-cloudfront:** KeyValueStore reads in CloudFront Functions (--from-cfn-stack + --kvs-file) ([#406](https://github.com/go-to-k/cdk-local/issues/406)) ([7dbf2c9](https://github.com/go-to-k/cdk-local/commit/7dbf2c981af5266595aa846ff62080a0c8b7fd86))

## [0.118.1](https://github.com/go-to-k/cdk-local/compare/v0.118.0...v0.118.1) (2026-06-04)


### Bug Fixes

* **studio:** unify serve-child logs onto stdout so the LOG panel keeps emission order ([#404](https://github.com/go-to-k/cdk-local/issues/404)) ([5ee744b](https://github.com/go-to-k/cdk-local/commit/5ee744b4f06fd6dbf1f6b8a7166561327516de55))

# [0.118.0](https://github.com/go-to-k/cdk-local/compare/v0.117.0...v0.118.0) (2026-06-04)


### Features

* **studio:** preserve serve composer inputs across Start -> Stop ([#401](https://github.com/go-to-k/cdk-local/issues/401)) ([f26a56a](https://github.com/go-to-k/cdk-local/commit/f26a56ad5eeb6cd4e6c9f61190ddb103a844f345))

# [0.117.0](https://github.com/go-to-k/cdk-local/compare/v0.116.0...v0.117.0) (2026-06-04)


### Features

* **studio:** make the image-override Dockerfile picker more legible ([#397](https://github.com/go-to-k/cdk-local/issues/397)) ([71231bf](https://github.com/go-to-k/cdk-local/commit/71231bf2ce00a73d1813b3b66468423b00575a03))

# [0.116.0](https://github.com/go-to-k/cdk-local/compare/v0.115.0...v0.116.0) (2026-06-04)


### Features

* **studio:** Stop button shows a transient "Stopping..." (+ "Starting..." symmetry) ([#394](https://github.com/go-to-k/cdk-local/issues/394)) ([#395](https://github.com/go-to-k/cdk-local/issues/395)) ([385dec3](https://github.com/go-to-k/cdk-local/commit/385dec38d2293093d6cf3f6dad07a2279b935e99))

# [0.115.0](https://github.com/go-to-k/cdk-local/compare/v0.114.0...v0.115.0) (2026-06-04)


### Features

* **studio:** surface an ecs serve's auto-published replica host port to the request composer ([#392](https://github.com/go-to-k/cdk-local/issues/392)) ([#393](https://github.com/go-to-k/cdk-local/issues/393)) ([c39d809](https://github.com/go-to-k/cdk-local/commit/c39d809ce97314a9bd0c9db90fbe4cc5fca3b929))

# [0.114.0](https://github.com/go-to-k/cdk-local/compare/v0.113.0...v0.114.0) (2026-06-04)


### Features

* **studio:** image-override Dockerfile picker for ECS Task Definitions ([#388](https://github.com/go-to-k/cdk-local/issues/388)) ([#391](https://github.com/go-to-k/cdk-local/issues/391)) ([f73c0ff](https://github.com/go-to-k/cdk-local/commit/f73c0ff5fb1b74e72e62abd9f1889c74ae46e7a7))

# [0.113.0](https://github.com/go-to-k/cdk-local/compare/v0.112.0...v0.113.0) (2026-06-04)


### Features

* **run-task:** --image-override rebuilds a pinned task-def image from a local Dockerfile (slice A of [#388](https://github.com/go-to-k/cdk-local/issues/388)) ([#390](https://github.com/go-to-k/cdk-local/issues/390)) ([61ddd2e](https://github.com/go-to-k/cdk-local/commit/61ddd2ecdadc251eab1f708df9b6a95d50d50a57))

# [0.112.0](https://github.com/go-to-k/cdk-local/compare/v0.111.0...v0.112.0) (2026-06-04)


### Features

* **start-alb,studio:** [#380](https://github.com/go-to-k/cdk-local/issues/380) env/state/role parity for ALB Lambda targets + studio cloudfront bindings ([#389](https://github.com/go-to-k/cdk-local/issues/389)) ([32cbb81](https://github.com/go-to-k/cdk-local/commit/32cbb817366064fe7fac99bb480edf66cd0aba7c))

# [0.111.0](https://github.com/go-to-k/cdk-local/compare/v0.110.0...v0.111.0) (2026-06-04)


### Features

* **studio:** re-classify targets when --from-cfn-stack changes in the Session bar ([#385](https://github.com/go-to-k/cdk-local/issues/385)) ([#387](https://github.com/go-to-k/cdk-local/issues/387)) ([230c143](https://github.com/go-to-k/cdk-local/commit/230c14306633e45d0fd5902d79c9175e4a7ad829))

# [0.110.0](https://github.com/go-to-k/cdk-local/compare/v0.109.0...v0.110.0) (2026-06-04)


### Features

* **start-cloudfront:** apply CloudFront ResponseHeadersPolicy CORS (preflight + response headers) ([#386](https://github.com/go-to-k/cdk-local/issues/386)) ([bb6411c](https://github.com/go-to-k/cdk-local/commit/bb6411c1ead7226d1984c67614d9b8e846df1fbe))

# [0.109.0](https://github.com/go-to-k/cdk-local/compare/v0.108.0...v0.109.0) (2026-06-04)


### Features

* **studio:** image-override Dockerfile picker for an ALB's pinned backing services ([#383](https://github.com/go-to-k/cdk-local/issues/383)) ([c754a3b](https://github.com/go-to-k/cdk-local/commit/c754a3b79ac49a140309749eb0d2a9b82511a716))

# [0.108.0](https://github.com/go-to-k/cdk-local/compare/v0.107.1...v0.108.0) (2026-06-04)


### Features

* **start-cloudfront:** full env-var + --from-cfn-stack + --assume-role parity for a Function URL origin Lambda ([#380](https://github.com/go-to-k/cdk-local/issues/380) slice A) ([#382](https://github.com/go-to-k/cdk-local/issues/382)) ([e1527a3](https://github.com/go-to-k/cdk-local/commit/e1527a37a6b50b8e15139a0bf8e4c914983581fb))

## [0.107.1](https://github.com/go-to-k/cdk-local/compare/v0.107.0...v0.107.1) (2026-06-04)


### Bug Fixes

* **start-service:** print the pinned-image WARN before the endpoints banner + "Press ^C" ([#381](https://github.com/go-to-k/cdk-local/issues/381)) ([c2f9f91](https://github.com/go-to-k/cdk-local/commit/c2f9f910c4dd5305a94a2f3233b801b418beb1a4))

# [0.107.0](https://github.com/go-to-k/cdk-local/compare/v0.106.1...v0.107.0) (2026-06-04)


### Features

* **start-cloudfront:** serve a Lambda Function URL custom origin ([#376](https://github.com/go-to-k/cdk-local/issues/376)) ([#378](https://github.com/go-to-k/cdk-local/issues/378)) ([eacfcf9](https://github.com/go-to-k/cdk-local/commit/eacfcf91247e21d7f468f6ae161de360cf4115e5))

## [0.106.1](https://github.com/go-to-k/cdk-local/compare/v0.106.0...v0.106.1) (2026-06-03)


### Bug Fixes

* **studio:** surface a serve crash instead of silently reverting to a blank composer ([#374](https://github.com/go-to-k/cdk-local/issues/374)) ([90f75db](https://github.com/go-to-k/cdk-local/commit/90f75dbabab21e5b54ec61ebcc9faaedd777abcf))

# [0.106.0](https://github.com/go-to-k/cdk-local/compare/v0.105.0...v0.106.0) (2026-06-03)


### Features

* **studio:** run CloudFront distributions from cdkl studio (start-cloudfront) ([#371](https://github.com/go-to-k/cdk-local/issues/371)) ([85c9df9](https://github.com/go-to-k/cdk-local/commit/85c9df901a80c75ef733262bfe7b614f3428e9d9))

# [0.105.0](https://github.com/go-to-k/cdk-local/compare/v0.104.1...v0.105.0) (2026-06-03)


### Features

* **cloudfront:** serve a CloudFront distribution locally (start-cloudfront) ([#370](https://github.com/go-to-k/cdk-local/issues/370)) ([622f412](https://github.com/go-to-k/cdk-local/commit/622f4124491848baa72e59e9f6de6a7f4f682f5f))

## [0.104.1](https://github.com/go-to-k/cdk-local/compare/v0.104.0...v0.104.1) (2026-06-03)


### Bug Fixes

* **studio:** detect a --from-cfn-stack-pinned ECS service at boot (image-override picker) ([#369](https://github.com/go-to-k/cdk-local/issues/369)) ([6a48f6c](https://github.com/go-to-k/cdk-local/commit/6a48f6cd78ce42df6782bf9ee1b517c1c512706f))

# [0.104.0](https://github.com/go-to-k/cdk-local/compare/v0.103.9...v0.104.0) (2026-06-03)


### Features

* **studio:** add a [Run] control for ECS task definitions (run-task) ([#368](https://github.com/go-to-k/cdk-local/issues/368)) ([faea92f](https://github.com/go-to-k/cdk-local/commit/faea92fd46e8e4b08f122226e4be4f53c7ed1b3a))

## [0.103.9](https://github.com/go-to-k/cdk-local/compare/v0.103.8...v0.103.9) (2026-06-03)


### Bug Fixes

* **ecs:** auto-remap a privileged declared host port to a free high port ([#364](https://github.com/go-to-k/cdk-local/issues/364)) ([925a9ef](https://github.com/go-to-k/cdk-local/commit/925a9efdf61a85b0c12514a9b1961167c9351450))

## [0.103.8](https://github.com/go-to-k/cdk-local/compare/v0.103.7...v0.103.8) (2026-06-03)


### Bug Fixes

* **studio:** add env-vars to the start-alb / start-service serve composers ([#362](https://github.com/go-to-k/cdk-local/issues/362)) ([c265a3c](https://github.com/go-to-k/cdk-local/commit/c265a3c1396688bb5d0aaecd63a6d48201203927))

## [0.103.7](https://github.com/go-to-k/cdk-local/compare/v0.103.6...v0.103.7) (2026-06-03)


### Bug Fixes

* **studio:** show a "Started with" summary of a serve's launch options ([#361](https://github.com/go-to-k/cdk-local/issues/361)) ([8d2d7f1](https://github.com/go-to-k/cdk-local/commit/8d2d7f17a52327c2ef7197095d34f5f3e12e0cc3))

## [0.103.6](https://github.com/go-to-k/cdk-local/compare/v0.103.5...v0.103.6) (2026-06-03)


### Bug Fixes

* **studio:** hide custom-resource Lambdas with a generic Custom:: path ([#360](https://github.com/go-to-k/cdk-local/issues/360)) ([d811bee](https://github.com/go-to-k/cdk-local/commit/d811bee02d3531a586f9f712341e278a0308d666))

## [0.103.5](https://github.com/go-to-k/cdk-local/compare/v0.103.4...v0.103.5) (2026-06-03)


### Bug Fixes

* **studio:** split ECS Services and Task Definitions into separate target groups ([#358](https://github.com/go-to-k/cdk-local/issues/358)) ([26935ec](https://github.com/go-to-k/cdk-local/commit/26935ec5331e35cd26bde2b3dd63b0e25819ff99))

## [0.103.4](https://github.com/go-to-k/cdk-local/compare/v0.103.3...v0.103.4) (2026-06-03)


### Bug Fixes

* **start-alb:** auto-remap privileged listener ports instead of crashing ([#353](https://github.com/go-to-k/cdk-local/issues/353)) ([7d4a297](https://github.com/go-to-k/cdk-local/commit/7d4a297f377eb820b2bde77b8ca9142e0ccd8a2f))

## [0.103.3](https://github.com/go-to-k/cdk-local/compare/v0.103.2...v0.103.3) (2026-06-03)


### Bug Fixes

* **studio:** --assume-role checkbox does nothing (post-apply loadConfig) ([#350](https://github.com/go-to-k/cdk-local/issues/350)) ([488efaa](https://github.com/go-to-k/cdk-local/commit/488efaa9159202e5e0ec92104992d24acadad61f))

## [0.103.2](https://github.com/go-to-k/cdk-local/compare/v0.103.1...v0.103.2) (2026-06-03)


### Bug Fixes

* **studio:** survive stray errors + remember the Headers editor mode ([#347](https://github.com/go-to-k/cdk-local/issues/347)) ([3ffd0fa](https://github.com/go-to-k/cdk-local/commit/3ffd0fac87638dbfa6fcbe28aa070bbbdaf5ac7f))

## [0.103.1](https://github.com/go-to-k/cdk-local/compare/v0.103.0...v0.103.1) (2026-06-03)


### Bug Fixes

* **studio:** give --assume-role a checkbox so the Session bar is symmetric ([#344](https://github.com/go-to-k/cdk-local/issues/344)) ([663e73d](https://github.com/go-to-k/cdk-local/commit/663e73dcb9661ed197df1b579f374daa6cb404f0))

# [0.103.0](https://github.com/go-to-k/cdk-local/compare/v0.102.2...v0.103.0) (2026-06-03)


### Features

* **studio:** KV / JSON toggle for the request composer's Headers ([#342](https://github.com/go-to-k/cdk-local/issues/342)) ([8d3942a](https://github.com/go-to-k/cdk-local/commit/8d3942acbf541963de047423d43cd58f3b206766))

## [0.102.2](https://github.com/go-to-k/cdk-local/compare/v0.102.1...v0.102.2) (2026-06-03)


### Bug Fixes

* **studio:** keep the serve composer alive across streamed log events ([#341](https://github.com/go-to-k/cdk-local/issues/341)) ([c2d0978](https://github.com/go-to-k/cdk-local/commit/c2d0978112500d110d8afcdf820ef31599aac640))

## [0.102.1](https://github.com/go-to-k/cdk-local/compare/v0.102.0...v0.102.1) (2026-06-03)


### Bug Fixes

* **studio:** visual polish — zebra contrast, wider session inputs, LOGS clear ([#340](https://github.com/go-to-k/cdk-local/issues/340)) ([2f25581](https://github.com/go-to-k/cdk-local/commit/2f25581fa276a6ff38e7bdffa59212614126730f))

# [0.102.0](https://github.com/go-to-k/cdk-local/compare/v0.101.0...v0.102.0) (2026-06-03)


### Features

* **studio:** re-invoke a past timeline row with an edited payload ([#332](https://github.com/go-to-k/cdk-local/issues/332)) ([bd37582](https://github.com/go-to-k/cdk-local/commit/bd37582b5ee3ca598f1a681d664a74a7916b17b2))

# [0.101.0](https://github.com/go-to-k/cdk-local/compare/v0.100.0...v0.101.0) (2026-06-03)


### Features

* **invoke:** add --response-file so studio reads the raw response (not stdout) ([#331](https://github.com/go-to-k/cdk-local/issues/331)) ([488d941](https://github.com/go-to-k/cdk-local/commit/488d9419dcdd0830b0d816d781144240ac7644e5))

# [0.100.0](https://github.com/go-to-k/cdk-local/compare/v0.99.0...v0.100.0) (2026-06-03)


### Features

* **studio:** clarify the curl-able serve port (proxy vs child internal) ([#330](https://github.com/go-to-k/cdk-local/issues/330)) ([c2d94b6](https://github.com/go-to-k/cdk-local/commit/c2d94b6a59c1e02ff9ddac73d3c0ab8ab0d9edd5))

# [0.99.0](https://github.com/go-to-k/cdk-local/compare/v0.98.0...v0.99.0) (2026-06-03)


### Features

* **studio:** exclude custom-resource / provider Lambdas from the target list by default ([#329](https://github.com/go-to-k/cdk-local/issues/329)) ([d02a2a7](https://github.com/go-to-k/cdk-local/commit/d02a2a7a958a5049b1be8d1624cc07df9c0d0541))

# [0.98.0](https://github.com/go-to-k/cdk-local/compare/v0.97.1...v0.98.0) (2026-06-03)


### Features

* **studio:** in-workspace HTTP request composer for served api / alb / ecs ([#328](https://github.com/go-to-k/cdk-local/issues/328)) ([40896b2](https://github.com/go-to-k/cdk-local/commit/40896b294e288cfc79f267a6795c060902e4b0ef))

## [0.97.1](https://github.com/go-to-k/cdk-local/compare/v0.97.0...v0.97.1) (2026-06-03)


### Performance Improvements

* **studio:** reuse the boot synth for spawned children (avoid the double synth) ([#327](https://github.com/go-to-k/cdk-local/issues/327)) ([6be552d](https://github.com/go-to-k/cdk-local/commit/6be552d83144f6b725c1faed01b9c95c5d817a09))

# [0.97.0](https://github.com/go-to-k/cdk-local/compare/v0.96.1...v0.97.0) (2026-06-03)


### Features

* **studio:** target-pane UX (zebra + collapsible groups + filter) + apply-on-change Session bar ([#326](https://github.com/go-to-k/cdk-local/issues/326)) ([5436dbc](https://github.com/go-to-k/cdk-local/commit/5436dbc19d4205159be2f4cdf59ff8f227696d4e))

## [0.96.1](https://github.com/go-to-k/cdk-local/compare/v0.96.0...v0.96.1) (2026-06-03)


### Bug Fixes

* **studio:** bind AgentCore invocation logs strictly by container id ([#321](https://github.com/go-to-k/cdk-local/issues/321)) ([bf408e2](https://github.com/go-to-k/cdk-local/commit/bf408e233dcc0654bcdf8e39e8a7617bea8b8b32))

# [0.96.0](https://github.com/go-to-k/cdk-local/compare/v0.95.0...v0.96.0) (2026-06-03)


### Features

* **studio:** image-override Dockerfile picker for pinned ECS services ([#320](https://github.com/go-to-k/cdk-local/issues/320)) ([e70dad3](https://github.com/go-to-k/cdk-local/commit/e70dad3403fc75f66002a9d13db3133afa9b60fa))

# [0.95.0](https://github.com/go-to-k/cdk-local/compare/v0.94.0...v0.95.0) (2026-06-03)


### Features

* **studio:** add an "All options" section (auto-derived flag catalog + raw extra args) ([#317](https://github.com/go-to-k/cdk-local/issues/317)) ([cd0e355](https://github.com/go-to-k/cdk-local/commit/cd0e35578132de08b3fc9ff96c572d0e6d45bd40))

# [0.94.0](https://github.com/go-to-k/cdk-local/compare/v0.93.0...v0.94.0) (2026-06-03)


### Features

* **studio:** lead the Session bar with the watch toggle; drop the SESSION label ([#316](https://github.com/go-to-k/cdk-local/issues/316)) ([6a946ec](https://github.com/go-to-k/cdk-local/commit/6a946ecc2695af5655d0ae1edc5e2d9ec515be83))

# [0.93.0](https://github.com/go-to-k/cdk-local/compare/v0.92.0...v0.93.0) (2026-06-03)


### Features

* **studio:** in-browser WebSocket console for served WebSocket APIs ([#303](https://github.com/go-to-k/cdk-local/issues/303)) ([#315](https://github.com/go-to-k/cdk-local/issues/315)) ([a3b0275](https://github.com/go-to-k/cdk-local/commit/a3b0275eed2ab60a42503efba416ea3323391119))

# [0.92.0](https://github.com/go-to-k/cdk-local/compare/v0.91.0...v0.92.0) (2026-06-03)


### Features

* **studio:** brand as "CDK Local Studio" + slim tagline + refresh the GIF ([#313](https://github.com/go-to-k/cdk-local/issues/313)) ([836267f](https://github.com/go-to-k/cdk-local/commit/836267fd580cd92269822ba860ccd5f60a88da22))

# [0.91.0](https://github.com/go-to-k/cdk-local/compare/v0.90.0...v0.91.0) (2026-06-03)


### Features

* **start-api:** accept a WebSocket API as an explicit target ([#311](https://github.com/go-to-k/cdk-local/issues/311)) ([#314](https://github.com/go-to-k/cdk-local/issues/314)) ([12ea0c9](https://github.com/go-to-k/cdk-local/commit/12ea0c9d09f80aa3baae347b6b5ea343dab1030a))

# [0.90.0](https://github.com/go-to-k/cdk-local/compare/v0.89.0...v0.90.0) (2026-06-03)


### Features

* **studio:** --watch — hot-reload serves started from the UI ([#301](https://github.com/go-to-k/cdk-local/issues/301)) ([#310](https://github.com/go-to-k/cdk-local/issues/310)) ([f2d375a](https://github.com/go-to-k/cdk-local/commit/f2d375ab45251c7657c9d615995c2366f6081ece))

# [0.89.0](https://github.com/go-to-k/cdk-local/compare/v0.88.0...v0.89.0) (2026-06-03)


### Features

* **studio:** make AgentCore runtimes runnable from the UI ([#303](https://github.com/go-to-k/cdk-local/issues/303)) ([#308](https://github.com/go-to-k/cdk-local/issues/308)) ([972e200](https://github.com/go-to-k/cdk-local/commit/972e20078a84232b8e800a28ae2b37c92051a5a2))

# [0.88.0](https://github.com/go-to-k/cdk-local/compare/v0.87.0...v0.88.0) (2026-06-03)


### Features

* **studio:** --stack <glob> target-list filter ([#301](https://github.com/go-to-k/cdk-local/issues/301)) ([#307](https://github.com/go-to-k/cdk-local/issues/307)) ([0997e37](https://github.com/go-to-k/cdk-local/commit/0997e37d8fc07c6652329a9a513b3b56873476fb))

# [0.87.0](https://github.com/go-to-k/cdk-local/compare/v0.86.0...v0.87.0) (2026-06-03)


### Features

* **studio:** editable Session bar — live-edit from-cfn-stack / assume-role ([#301](https://github.com/go-to-k/cdk-local/issues/301)) ([#306](https://github.com/go-to-k/cdk-local/issues/306)) ([6bb32cd](https://github.com/go-to-k/cdk-local/commit/6bb32cdd4c96b0e1370f14d3201d7afe2f9e95eb))

# [0.86.0](https://github.com/go-to-k/cdk-local/compare/v0.85.0...v0.86.0) (2026-06-02)


### Features

* **studio:** per-target run options in the UI composer ([#301](https://github.com/go-to-k/cdk-local/issues/301)) ([#304](https://github.com/go-to-k/cdk-local/issues/304)) ([1a89adb](https://github.com/go-to-k/cdk-local/commit/1a89adb40aa9f03e0d6b004d01abccdc780028e1))

# [0.85.0](https://github.com/go-to-k/cdk-local/compare/v0.84.0...v0.85.0) (2026-06-02)


### Features

* **studio:** session-global --from-cfn-stack / --assume-role threaded to children ([#301](https://github.com/go-to-k/cdk-local/issues/301)) ([#302](https://github.com/go-to-k/cdk-local/issues/302)) ([ab0cf6c](https://github.com/go-to-k/cdk-local/commit/ab0cf6c86fe4ccc12745c0fcc301b414f9558bb6))

# [0.84.0](https://github.com/go-to-k/cdk-local/compare/v0.83.0...v0.84.0) (2026-06-02)


### Features

* **studio:** unveil `cdkl studio` + fix per-invocation log binding ([#282](https://github.com/go-to-k/cdk-local/issues/282)) ([#300](https://github.com/go-to-k/cdk-local/issues/300)) ([31f3eb3](https://github.com/go-to-k/cdk-local/commit/31f3eb36448f818258e3e0c1dcc5e8801fda908e))

# [0.83.0](https://github.com/go-to-k/cdk-local/compare/v0.82.0...v0.83.0) (2026-06-02)


### Features

* **studio:** Phase 1 serve-kinds — start/stop + capture for ALB and ECS service ([#282](https://github.com/go-to-k/cdk-local/issues/282)) ([#298](https://github.com/go-to-k/cdk-local/issues/298)) ([6f1bfea](https://github.com/go-to-k/cdk-local/commit/6f1bfea19de06cd096c6b4c65d7493079bd8c949))

# [0.82.0](https://github.com/go-to-k/cdk-local/compare/v0.81.1...v0.82.0) (2026-06-02)


### Features

* **studio:** Phase 1 slice C3 — session history, full-text log search, per-request logs ([#282](https://github.com/go-to-k/cdk-local/issues/282)) ([#296](https://github.com/go-to-k/cdk-local/issues/296)) ([384d1dc](https://github.com/go-to-k/cdk-local/commit/384d1dc749049c53c0da69d75a817bf6a9148a0f))

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
