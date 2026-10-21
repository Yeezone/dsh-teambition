# Contributing / 贡献指南

This repository is a single-package DSH Web GUI plugin. `main` is the development
trunk; released lines live on `vX.Y` branches. The rules below are the contract
for every change.

本仓库是单包 DSH Web GUI 插件。`main` 是开发主干，已发布的版本线放在 `vX.Y`
分支上。以下是每次改动都要遵守的约定。

## Branch model / 分支模型

| Branch | Purpose | 用途 |
| --- | --- | --- |
| `main` | development trunk, next release | 开发主干，下一个版本 |
| `v0.1` | frozen `v0.1` release line (`0.1.x`) | `v0.1` 发布线（`0.1.x`），已冻结 |
| `feat/<slug>` | a new feature, branched from `main` | 新功能分支，从 `main` 切出 |
| `fix/<slug>` | a bug fix, branched from `main` (or the release line) | 修复分支 |

Rules / 规则:

1. Never commit a feature or fix straight to `main` or a `vX.Y` branch. Open a
   `feat/...` or `fix/...` branch, then merge through a pull request.
   功能与修复一律先开 `feat/...`、`fix/...` 分支，再走 PR 合并。
2. Every change that lands on `main` bumps `version` in `package.json`:
   a feature bumps the minor version (`0.1.0` → `0.2.0`), a fix bumps the patch
   version (`0.2.0` → `0.2.1`), a breaking change bumps the major version.
   任何落到 `main` 的改动都要升级 `package.json` 的 `version`：新功能升 minor，
   修复升 patch，破坏性改动升 major。
3. Add a matching entry to `CHANGELOG.md` in the same pull request.
   同一个 PR 里要在 `CHANGELOG.md` 补对应条目。
4. Release-line branches (`v0.1`, ...) only take cherry-picked fixes, and each
   one ships as a new patch tag on that line.
   发布线分支（`v0.1` …）只接受 cherry-pick 的修复，每个修复在该线上打新的
   patch tag 发布。
5. Tag a release only after `main` CI is green: annotated tag `v<version>`
   (for example `v0.2.0`) plus a GitHub Release written from `CHANGELOG.md`.
   `main` 的 CI 绿了才发版：打 annotated tag `v<version>`，并用 `CHANGELOG.md`
   写 GitHub Release。

## Pre-merge checks / 合并前检查

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

The pull request template repeats this list; CI runs the same commands on Node 24
with pnpm 11.24.0.

## Code rules / 代码规则

See [AGENTS.md](AGENTS.md) for the full list (browser bundle purity gate, the
host-side cookie rule, locale parity, design tokens). In short: the client half
only type-imports `@deepseek-ai/*`, the Teambition cookie never leaves the host,
UI copy ships as a zh/en pair, and styling uses `--dsw-alias-*` tokens only.

完整规则见 [AGENTS.md](AGENTS.md)：浏览器半区只允许类型导入 `@deepseek-ai/*`、
Teambition Cookie 只在 Host 侧、文案中英成对、样式只用 `--dsw-alias-*` token。
