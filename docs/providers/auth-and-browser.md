# Auth state and the browser

The framework runs the browser and keeps the login. The provider tells it where the service lives and how to read the page. This page draws that line, says what the saved auth state is, and states the project's stance on bot protection.

The order of provider calls during an open, a close and `auth login` is in [contract.md](contract.md#lifecycle). Where the files live and how users manage them is in [../users/configuration.md](../users/configuration.md#files-on-disk).

## Who owns what

| The framework owns | The provider owns |
|---|---|
| Launching Chromium, headless or headful. | `chatUrl`, the page a session opens on. |
| One browser context per session, with the saved auth state loaded into it. | `navigateToLogin`: where a user logs in. |
| Reduced-motion emulation for that context (see [Reduced motion](#reduced-motion)). | `isLoggedIn`: whether the page is logged in. |
| The single `Page` every provider call receives. | Selectors, `sendMessage` and completion detection in `waitForResponse`. |
| Saving the auth state after login and at a clean close. | `detectBlock`, when the service can block the automated browser. |
| Closing the browser, and killing it when a close hangs. | `browser.reducedMotion`, when the default must change. |
| Deleting the auth state on logout. | |

Chromium runs as its own process, so the framework can SIGKILL it when the page is wedged and a close cannot finish. A kill saves nothing.

A provider never launches a browser, opens a second context, or reads or writes the auth-state file. It acts only on the `Page` it is given.

## Auth state

### What it is

The auth state is Playwright's storage state for the session's browser context, taken with IndexedDB included:

- cookies,
- localStorage,
- IndexedDB.

`sessionStorage` is not part of it. A service that keeps its session only there will look logged out on the next launch. Playwright also refuses to serialise some IndexedDB values (Blobs, for example); a save then fails with Playwright's error.

### What it is not

It is never a username or a password. The framework has no field, prompt or config key for credentials. The user types them into the service's own page, in a headful window, and the framework keeps only the browser state that results.

Keep it that way in your provider:

- `navigateToLogin` lands on a page and stops. It does not fill in a form.
- A conversation handle (see [extension-points/conversation.md](extension-points/conversation.md)) is stored by the UI and must never embed a token or a credential.
- Never log the auth state, and never put cookie or token values in an error message or a progress line.

### Where it lives

```
~/.config/<configDir>/auth/<provider name>.json
```

`<configDir>` comes from `createCli` or `createExtension` (see [define-provider.md](define-provider.md)). The provider's `name` is the file name, which is why `name` must be plain lowercase with no path separators. The directory is created with mode `0700` and the file is written with mode `0600`; both modes are enforced after creation, so a loose umask does not widen them.

### When it is loaded

At every launch, when the file exists: every session open, every reopen after an idle close, and `auth login` itself. Without the file, a session open fails before any browser work (see [Errors](#errors)).

### When it is saved

- At the end of a successful login, once `isLoggedIn` returned `true`.
- At every clean close of a session, if `isLoggedIn` still returns `true`. Services rotate tokens, so the state from the login goes stale; saving at close keeps the rotated one. If `isLoggedIn` returns `false`, nothing is saved:

  ```
  Session is no longer logged in; auth state not saved.
  ```

- Never after a kill, and never after a cancelled login.

A failed save does not block the close. It is reported as progress:

```
Could not save auth state: <message>
```

### When it is deleted

`auth logout`, `/logout` in interactive mode, and the VSCode Log out command delete that provider's file. Deleting a file that is not there is not an error. Nothing else deletes it; an expired state stays on disk until the next login overwrites it.

## The login flow

Three entry points run the same flow: `auth login` (see [../users/cli.md](../users/cli.md#auth-subcommands)), `/login` in interactive mode, and the VSCode Log in command.

1. Chromium is launched headful, whatever the headless setting says.
2. The page's default timeout becomes 30 s.
3. `navigateToLogin(page)` runs.
4. Progress shows `Please log in to <name>.`
5. `isLoggedIn(page)` runs once a second until it returns `true`. There is no overall deadline.
6. The auth state is saved and the browser closes.

The user can cancel at any point: Ctrl-C in the CLI, or the cancel button in VSCode. The browser is killed, nothing is saved, and the CLI exits 130.

### SSO, MFA and corporate identity providers

What happens inside the headful window is the user's business. The service may redirect to an identity provider, ask for a second factor, or show a consent page. The framework does not see any of it. It only asks `isLoggedIn` once a second.

For the provider author, that means:

- `navigateToLogin` only needs to reach the first page of the flow. Going to `chatUrl` and letting the service redirect is often enough.
- `isLoggedIn` is called on whatever page the flow is showing, including the identity provider's own pages. It must return `false` there, not throw. A throw ends the login.
- Each `isLoggedIn` call runs under the 30 s default timeout, so a Playwright wait inside it should use a short `timeout` of its own. The check should read the page, for example whether the chat input exists, rather than wait for it.
- Return `true` only when the chat page is really usable. A `true` while the flow is still redirecting saves a half-finished state.
- Cookies set by the identity provider's domain are in the context too, and are saved with the rest.

The framework has no hook for SSO, MFA or a specific identity provider, and will not get one. If an identity provider refuses the automated browser, that is a block (see [Bot protection](#bot-protection)).

## Headless and headful

Sessions run headless unless the user asks otherwise:

| Where | Headful when |
|---|---|
| CLI, one-shot and interactive | `--headful` is passed. |
| VSCode | The user set `<id>.headless` to `false`, or the vendor passed `createExtension({ headless: false })` and the user set nothing. A `default` declared in the manifest only feeds the Settings UI. |
| Login (all three entry points) | Always. |

The browser context is the same in both modes, reduced motion included, so a page you debug with `--headful` behaves like the headless one. What can differ is the service: some services treat headless Chromium as a bot. Test your provider headless before you ship it.

## Errors

The errors a provider author meets most around auth and the browser:

| Error | When | CLI exit | Retried by the opening phase |
|---|---|---|---|
| `AuthRequiredError` | No auth-state file for this provider. Raised before the browser launches. | 2 | No |
| `AuthExpiredError` | `isLoggedIn` returned `false` at open, or after a timeout, and `detectBlock` gave no description. | 3 | No |
| `BlockedError` | `isLoggedIn` returned `false` at open, or after a timeout, and `detectBlock` returned a description. | 6 | No |
| `BrowserUnavailableError` | Playwright's Chromium is not installed. | 7 | No |
| `ResponseTimeoutError` | A provider step hit its Playwright timeout. | 4 | If retries are configured, during the opening phase |

The messages:

```
No saved auth state for provider "<name>". Run `auth login` first.
Auth state for "<name>" is no longer valid. Run `auth login` again.
Blocked by "<name>": <description>.
Chromium is not installed (expected at <path>).
Timed out during <step> after <ms> ms.
```

`Chromium is not installed: <Playwright's first line>` is the second form of the missing-Chromium message, for a launch that fails after the pre-check passed.

The UIs add a remedy to two of them. For a block, the CLI and interactive mode append `Try --headful.` and VSCode shows:

```
Set the "<id>.headless" setting to false and try again.
```

For a missing Chromium, the CLI prints `Run: npx playwright install chromium` and VSCode offers its Install Browser command.

The first four are never retried, because opening again cannot fix them. A timeout and any other error during the opening phase are retried when retries are configured; see [../users/configuration.md](../users/configuration.md#opening-phase). All exit codes are in [../users/cli.md](../users/cli.md#exit-codes). Two more errors touch auth: `LoginAbortedError` (a cancelled login, exit 130), and `InvalidProviderError` (exit 5), raised when the provider's `name` cannot be used as the auth-state file name.

## Bot protection

This project drives company-internal and other cooperative chat services. It does not fight bot protection, and it will not.

When a service blocks the automated browser (a Cloudflare challenge in headless mode, an identity provider that refuses automated browsers), the framework's answer is:

1. The provider implements `detectBlock`, so the user gets exit 6 and the `--headful` hint instead of a misleading "log in again". See [extension-points/detect-block.md](extension-points/detect-block.md).
2. The user retries with `--headful`, or `<id>.headless` set to `false`. Sometimes that is enough.
3. That is as far as it goes.

Stealth plugins, user-agent spoofing and attaching to a personal Chrome profile will not be added to the framework. Do not add them to a provider either.

Public services appear in this repository only as spike targets that test the Provider contract. The ChatGPT spike, where this stance was decided, is in [../spike-notes/2026-09-08-chatgpt.md](../spike-notes/2026-09-08-chatgpt.md).

## Reduced motion

Every browser context emulates `prefers-reduced-motion: reduce`. This covers headless sessions, headful sessions and the login window.

The reason is CPU. A session can stay open for hours. Headless Chromium rasterises in software, so a chat page that keeps animating holds a CPU core busy for as long as the session is open. The measurement is in [../spike-notes/2026-09-20-idle-browser-cpu.md](../spike-notes/2026-09-20-idle-browser-cpu.md). The idle close in [extension-points/open-browser-idle.md](extension-points/open-browser-idle.md) is the other half of that fix.

A provider can opt out:

```ts
browser: { reducedMotion: "no-preference" },
```

`defineProvider` accepts only `"reduce"` and `"no-preference"`. There is no user setting for it.

Opt out only when the service misbehaves under reduced motion, typically because completion detection keys on an animation. Prefer to fix the detection instead: key `waitForResponse` on DOM state the service sets on purpose, such as a busy attribute or a stop button that disappears (see [contract.md](contract.md#waitforresponsepage)).
