# dsh-trello

Trello boards, lists, cards and comments as native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tools.

> **Uses a Trello API key + token for authentication (no OAuth or MCP), with
> plain outbound HTTPS requests to `api.trello.com`.** No public hostname,
> callback server, or separate HTTP service.

## Installation

1. **Build the files** (from this folder):

   ```sh
   npm install
   npm run build
   ```

2. **Install the plugin.** In DeepSeek Harness, open *Settings -> Plugins*
   and add the package by pointing at this folder's absolute path.
   (CLI-managed profiles: `dsh plugin --profile <profile> add <path>`.)

3. **Fill in your keys** in `cordis.patch.yml` (see
   [Configuration](#configuration)).

Restart Harness (or let HMR re-compose the profile) and the eight
`trello_*` tools appear in the session.

## Configuration

Installing the bundle inserts this row automatically (with empty
credentials):

```yaml
- id: tool-trello
  name: dsh-trello
  config:
    apiKey: ""
    token: ""
    # optional:
    # baseUrl: https://api.trello.com
    # timeoutMs: 30000
```

**Fill in the two values** in the installed package's `cordis.patch.yml`
(or, to survive reinstalls, in an override in your profile's
`cordis.patch.yml`):

```yaml
- id: tool-trello
  config:
    apiKey: PASTE_YOUR_API_KEY
    token: PASTE_YOUR_TOKEN
```

Credentials are read at first use, in this order:

1. **Config value** (non-empty): the `apiKey` / `token` above.
2. **Environment variables** (fallback): `TRELLO_API_KEY` and
   `TRELLO_TOKEN` in the environment of the Harness process.

Both credential fields are marked `secret` in the plugin config schema and
are stored as volatile references.

How to get the credentials:

1. Open <https://trello.com/apps/admin> and create a **new app** (no
   power-ups needed); pick **Trello Auth** as the app type.
2. On the app page, **copy the API key** and click **Generate Token** to
   get your token (choose the boards you want to expose).

Use a **dedicated token** with only the permissions you need.

When credentials are missing, every tool fails with:

```
Trello plugin is not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.
```

### Rotating / revoking credentials

- **Rotate**: generate a new token in Trello and replace `token` (or
  `TRELLO_TOKEN`). With volatile config, the change applies on the next
  tool call without a restart.
- **Revoke**: delete the token in Trello (*My tokens*). The API key stays
  valid but is useless without a token.

## Available tools

| Tool | Purpose |
|---|---|
| `trello_list_boards` | List boards accessible to the account |
| `trello_get_board` | Get one board by id |
| `trello_list_lists` | List the lists on a board |
| `trello_list_cards` | List the cards in a list |
| `trello_get_card` | Get one card by id |
| `trello_create_card` | Create a card in a list |
| `trello_update_card` | Update a card (only provided fields change); pass `listId` to move it to another list |
| `trello_add_comment` | Add a comment to a card |

Every tool except `trello_list_boards` takes an explicit id
(`boardId`, `listId`, or `cardId`), and all return compact summaries (not
raw Trello API objects). The three list tools accept an optional `limit`
(1–100, default 50). Card deletion is deliberately not part of the initial
tool set.

## Authentication

Trello's documented key/token mechanism: every request carries
`key=<apiKey>&token=<token>` as query parameters, with no Authorization header
or callback handling. A 401 from Trello surfaces as:

```
Trello authentication failed. Check TRELLO_API_KEY and TRELLO_TOKEN.
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Trello plugin is not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.` | Add `apiKey`/`token` to the profile row or export the environment variables. |
| `Trello authentication failed. ...` | The key/token pair is wrong or the token was revoked. Regenerate the token. |
| `Trello permission denied: ...` | The token was created without access to that board. Regenerate it with the needed boards selected. |
| `Trello board/list not found: <id>` | The id is wrong, or the token cannot see that resource. |
| `Trello API request failed: rate limit exceeded. Retry after N seconds.` | Trello rate limiting. Wait `N` seconds; keep call volume low. |
| `Trello service failure (HTTP 5xx).` | Trello-side problem; retry later. |
| Plugin does not appear in the session | Check that `dsh-trello` is in the profile's `dsh.profile.bundles` list, that the package installed cleanly (`pnpm list dsh-trello` in the profile), and that the row is not `disabled`. Run `dsh --profile <profile> --dump-config` to inspect the composed tree. |

## Local development

```sh
npm install
npm run build     # tsc -> dist/src (package) + dist/test
npm test          # builds, then runs node --test over dist/test/*.test.js
```

Two standalone checks run against the built output (no Harness required):

```sh
node scripts/smoke.mjs      # plugin contract: 8 tools, config error, auth, no leaks
node scripts/verify-dsh.mjs # real DSH schema gate + result validation
```

The Trello REST client (`src/trello/`) is independent of Harness and is
tested with a mocked `fetch`; no real Trello calls are made by the test
suite.


