# Warren

> A network of interconnected burrows. The control plane and UI for cloud-based custom agents that operate in isolation, self-manage, self-repair, and self-improve.

**Status:** V1 in development. See [SPEC.md](SPEC.md) for the full design.

Warren composes the os-eco data-plane tools — [canopy](https://github.com/jayminwest/canopy) (prompts), [mulch](https://github.com/jayminwest/mulch) (expertise), [seeds](https://github.com/jayminwest/seeds) (issues), [sapling](https://github.com/jayminwest/sapling) (harness) — and the [burrow](https://github.com/jayminwest/burrow) sandbox runtime into a single deployable system. One container, one volume, one HTTP API, one UI.

## Quick start (V1, post-build)

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env   # CANOPY_REPO_URL, ANTHROPIC_API_KEY, GITHUB_TOKEN
docker compose up -d
open http://localhost:8080
```

The same image deploys to Fly.io with a 50GB volume — see [SPEC.md §10](SPEC.md#10-deploy).

## Development

```bash
bun install
bun test                                   # run all tests
bun run lint                               # biome check
bun run typecheck                          # tsc --noEmit
bun test && bun run lint && bun run typecheck   # all quality gates
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations.

## Project layout

```
src/
├── index.ts            # library entry (V1: VERSION constant only)
├── core/               # types, errors, id minting
├── registry/           # canopy → agent definition resolution
├── projects/           # GitHub clone management
├── runs/               # spawn, stream, reap composition flow (SPEC §4.3)
├── burrow-client/      # facade over @os-eco/burrow HttpClient
├── supervisor/         # container entrypoint (spawns warren + burrow serve)
├── server/             # Bun.serve HTTP API + static UI serving
├── db/                 # drizzle schema, migrations, repos
├── cli/                # `warren` admin commands
└── ui/                 # React + Vite + shadcn SPA
```

## License

MIT — see [LICENSE](LICENSE).
