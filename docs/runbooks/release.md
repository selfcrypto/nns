# Publishing the libraries to npm

Three of the twelve workspace packages are published. The other nine are
services and tooling: they reach a machine as a git checkout and a docker
image (`deploy.md`), and an npm tarball of a server nobody installs from npm
would be a second distribution channel to keep honest for no one's benefit.

| Package | What an integrator does with it |
|---|---|
| `@nimiqnames/core` | Builds and parses messages; verifies §8.1/§8.2 bytes. Pure |
| `@nimiqnames/anchor` | Reads §9 anchors; ships the contract and its compiled artifact |
| `@nimiqnames/resolver` | Resolves a name with quorum and proof verification. **The one most people install** |

`@nimiqnames/resolver` also ships `dist/nns.js` — the same source bundled into one
self-contained ES module for a page with no build step. Publishing therefore
also publishes that file to every npm CDN, which is what
`docs/integration.md` §3.1's `<script type="module">` line points at.

## Before the first publish, once

The `@nimiqnames` scope must exist on npmjs.com and the publishing account
must own it. Create the organisation in the web UI — an npm account cannot
claim a scope by publishing into it — then:

```sh
npm login                       # the account that owns @nimiqnames
npm whoami                      # confirms which account is about to publish
npm access ls-packages          # nothing yet, on the first run
```

**The scope is `@nimiqnames`, not `@nns`** (2026-09-14). `nns` is not
available as an organisation — an unrelated package of that name has held it
since long before this project — and an npm scope that is not your username
has to be an organisation, so there was nothing to claim. The three published
packages therefore carry a different scope from the nine workspace packages
that are not published, which keep `@nns/`: renaming those would reach into
`.env.example`s and compose files the live boxes read, for names no consumer
ever types.

Nothing in this repository holds an npm credential, and nothing should: the
token lives in the operator's `~/.npmrc`, or in a CI secret if publishing ever
moves there.

## Every release

**1. Be on `main`, be current, be clean.**

```sh
git fetch origin && git status --short && git log --oneline HEAD..origin/main
```

**2. Verify the whole workspace.** All three, in this order — the narrow
build config and the wide check config catch different things:

```sh
pnpm build && pnpm typecheck && pnpm test
```

**3. Check the revision number is the truth.** `CONSTANTS.SPEC_REVISION` is
what a consumer asserts on to know whether their pinned copy still agrees
with the network, so a fold that moved a rule and left the number behind is
worse than no number at all:

```sh
node -e "import('./packages/core/dist/index.js').then(m => console.log(m.CONSTANTS.SPEC_REVISION))"
grep -n "v1 draft — revision" docs/nns-spec-v1.md | head -1
```

**4. Set the versions.** All three move together and share a number — they are
cut from one tree at one revision, and three independently drifting versions
would make "which core does this resolver want" a question anyone has to ask.
Keep the major at `0` while the spec is a draft.

```sh
pnpm -r --filter "@nimiqnames/core" --filter "@nimiqnames/anchor" --filter "@nimiqnames/resolver" \
  exec npm version <new-version> --no-git-tag-version
```

**5. Look at what will actually ship**, for each package. The tarball is
`files` plus the four npm always includes (`package.json`, `README.md`,
`LICENSE`, the entry point) — an artifact missing from `dist/` is the failure
this step catches, and it fails at a consumer's build rather than here:

```sh
pnpm --filter @nimiqnames/resolver exec npm pack --dry-run
```

`@nimiqnames/resolver` must list `dist/nns.js`, `dist/rendering.css` and
`dist/index.d.ts`. `@nimiqnames/core` must list `vectors/`.

**6. Publish.** Dependency order matters: `core`, then `anchor`, then
`resolver`. pnpm rewrites each `workspace:*` to the concrete version as it
packs, so no manifest is edited for the release.

```sh
pnpm publish --filter @nimiqnames/core --access public
pnpm publish --filter @nimiqnames/anchor --access public
pnpm publish --filter @nimiqnames/resolver --access public
```

`pnpm publish` refuses a dirty tree by default. Let it — a release built from
uncommitted edits is a release nobody can reproduce.

**7. Verify from outside the workspace**, which is the only verification that
means anything: a package that resolves only inside the monorepo is the exact
failure publishing exists to end.

```sh
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install @nimiqnames/resolver
node --input-type=module -e "
  import { createResolver, DEFAULT_RESOLVERS } from '@nimiqnames/resolver'
  console.log(DEFAULT_RESOLVERS)
  const r = await createResolver({}).resolve('ricochet')
  console.log(r.address, r.verification, r.quorum)
"
```

Expect `PROVEN` and a quorum of two agreeing — the shipped default list meets
`RESOLVER_QUORUM` without the caller configuring anything, and if it does not,
that is the bug to fix before announcing the release.

**8. Check the CDN copy**, a few minutes later:

```sh
curl -sI https://cdn.jsdelivr.net/npm/@nimiqnames/resolver/dist/nns.js | head -3
```

**9. Commit the version bump** to `main`, and roll the boxes out if anything
else changed with it (`deploy.md`).

## Things that will bite

- **A version is forever.** npm does not allow republishing one, and
  `npm unpublish` is available for 72 hours and breaks anyone who already
  installed it. A mistake is fixed by publishing the next patch.
- **`SPEC_REVISION` is the compatibility surface, not `version`.** Two
  releases can be API-identical and derive different roots. Say which
  revision a release implements in its notes.
- **`@nimiqnames/anchor` keeps `viem` and `solc` as devDependencies**, because no
  exported module reaches either — only the three CLIs do, and those are repo
  tooling. Do not "fix" this by promoting them: it puts ~85 MB into every
  install of `@nimiqnames/resolver`, for code a consumer cannot call.
  `docker/Dockerfile` is the other half of that decision — the anchor role
  skips the production prune because one of those CLIs is its entrypoint.
- **`dist/nns.js` is built by `vite build`, the third step of the resolver's
  `build` script.** If it is absent from the tarball, the build did not
  complete; publishing without it silently 404s every `<script>` tag in the
  integration guide that points at a CDN path.
