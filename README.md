# free-model-aggregator

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/whxxyu/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/whxxyu/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

A zero-dependency Node 22 aggregator that probes every provider in the brief, registers an exact free-model catalog, and routes each request to the highest-rated free model that meets its requirements — with per-provider failover across the OpenAI, Anthropic and Gemini wires, echo-faithful request/response translation (system, user, tools, images, max tokens, stops, JSON mode), and deterministic, replay-safe behavior. It reads the brief from $MAKEFUN_PROMPT_FILE, registers with $MAKEFUN_ENV_URL, serves /v1/chat/completions, /v1/messages and /v1/models, and exits when the environment reports the work done.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
