# ChatGPT sign-in for DSH

A standalone, Web-only companion plugin developed for DSH `0.2.1-rc.3`. It adds **Sign in with ChatGPT** to the existing Codex provider card and uses DSH's registered OAuth flow. Other DSH versions are not blocked, but compatibility is not guaranteed; if sign-in fails, verify against the documented version. No copied OAuth implementation, terminal command, Agent turn, or DSH source modification is required.

## Version compatibility

Development baseline (not installation requirements):

| Component | Developed against |
| --- | --- |
| DSH | `0.2.1-rc.3` |
| `@deepseek-ai/dsh-credentials` | `0.2.1-rc.3` |
| `@deepseek-ai/cordis` | `4.0.5` |
| `@deepseek-ai/schemastery` | `3.18.5` |

All runtime peers use `*`; there is no `engines.dsh` restriction. This allows updates, including prerelease DSH versions, without an exact-version exemption. It does **not** guarantee API compatibility or successful sign-in on other versions.

At plugin startup, the optional `@deepseek-ai/dsh-app-boot` peer supplies `getDshRuntimeVersion()` when available. A detected difference from the DSH baseline produces a Host log warning showing both versions; it does not prevent startup. Older runtimes without this helper, or failed version detection, are silently skipped. This is a startup warning, not an installation/update warning, and it does not compare individual peer versions.

## Install, update, remove

Use the GitHub repository directly. Run from a terminal where the `dsh` CLI is available:

Install into the `web` profile:

```sh
dsh plugin --profile web add git+https://github.com/odenta/dsh-openai-web-auth.git
```

To update later, remove the installed bundle and add it again so DSH fetches the current repository contents:

```sh
dsh plugin --profile web remove @local/dsh-openai-web-auth
dsh plugin --profile web add git+https://github.com/odenta/dsh-openai-web-auth.git
```

To remove it:

```sh
dsh plugin --profile web remove @local/dsh-openai-web-auth
```

If you run DSH through pnpm from its checkout, prefix each command with `pnpm` (for example, `pnpm dsh plugin ...`). Restart DSH if the CLI reports that the profile requires it, then refresh the Web page. Removing the bundle does not revoke credentials already saved by DSH.

## Use

Open **Settings → Models**. Open the existing `openai-codex` provider card, or choose **Add model provider → Third-party model provider → openai-codex**. Click **Sign in with ChatGPT**. Choose browser or device-code login when the provider asks; open the displayed link and follow its instructions. The dialog supports device codes, pasted redirect URLs, text, secret, and selection questions. Credentials and OAuth exchanges remain on the Host.

A successful result means DSH confirmed the credential was saved. Apply the provider settings separately if the provider has not been added, then select a model. Login alone does not verify model access. Device-code login must be enabled for the OpenAI account/workspace. A remote DSH Host cannot receive a callback sent to the browser machine's localhost; use the pasted redirect or device-code option offered by the provider.

## Ownership and cancellation

The plugin uses an authenticated Connection channel, accepts only the shared browser owner Peer, and scopes answers/cancellation to a random per-attempt capability held only by the initiating page. Other tabs cannot inspect or answer the attempt without that capability. One Codex login may run at a time.

Cancel, Escape, or clicking outside the dialog requests cancellation; browser unload aborts an outstanding wait. An attempt expires after `timeoutMs` (default 600000, configurable on the `openai-web-auth` row). Connection loss reports an uncertain outcome, not success or rollback. DSH's authorization service may allow an already-started provider write to finish after cancellation; the plugin does not revoke credentials. Plugin unload cancels its attempt before releasing its RPC channel.

Provider failures are reduced to safe error codes; raw exceptions and credential payloads are never sent to the browser. The latest eight notices are retained, with bounded message/link/code sizes. Answers are transient, bounded to 16384 characters, and never logged by the plugin. No login state enters the model context or Session log.

## Development

Runtime files are plain ESM on the Host and a DSH loader factory in the browser; no build or installation scripts are needed. DSH supplies the runtime peers; the versions above record the development baseline rather than dependency pins. Keep the DSH baseline in `compatibility.js` and this table in sync when deliberately updating it. Run `node --test tests/*.test.js` for keyless interaction tests. Set `DSH_CHECKOUT=/path/to/built/deepseek-harness` on that command to include the real Loader/HTTP/disk-storage smoke and sibling-provider lifecycle regression; these tests use isolated temporary credentials and a fake authorization flow, never OpenAI. After editing an installed linked bundle, reload it through DSH and refresh the Web page; do not assume source-file changes are live.

The icon is original artwork supplied with this plugin, not an OpenAI logo.
