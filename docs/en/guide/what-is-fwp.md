# What is FWP

**Fiammetta Watcher Proxy** (FWP) is an open-source multi-platform AI API proxy gateway.

## Why FWP?

When using multiple AI platforms (OpenAI, Anthropic, Google, etc.), you face several challenges:

- Each platform has different API formats and authentication methods
- You need to manage multiple API keys separately
- There's no unified way to monitor usage across platforms
- Manual switching is required when a platform goes down

**FWP solves these problems**: it provides a single entry point that intelligently routes requests to different backend platforms.

## Core Concepts

```
Client → FWP → OpenAI / Anthropic / Google / ...
```

- **Platform**: Backend AI service provider
- **API Key**: Authentication key used by clients

## Next Steps

- [Features](/en/guide/features) — full capability list
- [Quick Start](/en/guide/quickstart) — local install and setup
- [API Reference](/en/api/) — endpoint usage
- [Deployment Guide](/en/deployment/) — production deployment options

