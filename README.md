# Agent Outpost

Agent Outpost is a self-hosted, mobile-first control surface for a persistent
GitHub Copilot coding session. It is intended for a single developer running
an agent on a private Linux development host.

The first milestone provides:

- One persistent Copilot SDK session.
- A mobile conversation interface.
- Live updates over server-sent events.
- Message cancellation.
- Local conversation history.
- Local CPU, memory, and disk status.
- Validated blue-green self-deployment from `agent/current`.
- Private access through Tailscale.

## Architecture

```text
Phone on Tailscale
        |
        | HTTPS and server-sent events
        v
Agent Outpost on an Azure Linux VM
        |
        | GitHub Copilot SDK
        v
Persistent Copilot runtime and repository workspace
```

The application and SDK runtime bind only to loopback. Tailscale Serve provides
the private HTTPS endpoint and authenticated identity headers.

## Status

This repository is under active development. Azure provisioning and production
installation are not yet ready.

## Development requirements

- Node.js 22.12 or later
- GitHub Copilot CLI
- A GitHub account with an active Copilot subscription

```bash
npm install
cp .env.example .env
npm run dev
```

The server binds to loopback by default. The VM setup uses Tailscale
Serve to provide an authenticated HTTPS endpoint without exposing the
application publicly.

See the [bootstrap runbook](docs/bootstrap.md) for the intended deployment
sequence. Infrastructure is defined in [Bicep](infra/main.bicep); the deployment
script runs an Azure what-if unless `-Apply` is explicitly supplied.

Autonomous deployment requires the runbook's one-time
`bootstrap-self-deploy.sh` migration after the first healthy release. The
ordinary release installer deliberately does not grant or install privileged
deployment components.

## Security model

Agent Outpost is not a remote shell. The Copilot SDK permission handler allows
operations only within the configured workspace and restricts command
execution according to local policy. Tailscale identity is checked at the
application boundary in production.

Do not place GitHub, Copilot, Azure, or Tailscale credentials in this
repository.

## License

[MIT](LICENSE)
