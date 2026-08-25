# Release checklist

The build pipeline runs on every push to the main branch. Once the
artifacts are published, the release notes must be updated before

## Packaging

| step | command | owner |
| --- | --- | --- |
| build | pnpm build | ci |
| sign | ./scripts/sign.sh | ops |
| publish | pnpm publsh | ops |
