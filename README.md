# release-authenticator-action

GitHub Action that:

1. requests the workflow OIDC token
2. sends it to the exchange service
3. returns a short-lived GitHub App installation token
4. revokes that token in the post step by default

## Inputs

- `url` — full exchange endpoint URL, required
- `audience` — OIDC audience, optional, defaults to `new URL(url).origin`
- `skip-token-revoke` — optional, defaults to `false`

## Outputs

- `token`
- `expires-at`
- `repository`
- `ref`

## Usage

```yaml
permissions:
  id-token: write
  contents: write

steps:
  - uses: actions/checkout@v4

  - uses: astral-sh/release-authenticator-action@main
    id: app-token
    with:
      url: https://release-authenticator.<subdomain>.workers.dev/exchange

  - name: Create release
    env:
      GH_TOKEN: ${{ steps.app-token.outputs.token }}
    run: gh release create "v${{ inputs.version }}" --generate-notes
```

## Notes

- The default audience is the exchange URL origin, so set the Worker `EXPECTED_AUDIENCE` to that same value.
- If your runner requires `HTTP(S)_PROXY`, set `NODE_USE_ENV_PROXY=1` for the action step.
- The token is masked in logs.
- The token is revoked in the post step unless `skip-token-revoke: true`.
- Revocation retries transient GitHub/proxy failures and fails the post step if the token still cannot be confirmed invalid.
