# Technical guide: Tab Session Keeper 1.2.2

[Project overview](../README.md) · [Deutsche Anleitung](../README.de.md)

A local Chrome extension that keeps selected tabs active using background requests or supported application renewal methods. Forms and page state stay in place. Optional website rules automatically enable matching open tabs after a browser restart.

## Install or update

1. Extract `tab-session-keeper-1.2.2.zip` to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Pin Tab Session Keeper through Chrome's extensions menu.

Chrome 120 or newer is required. Installation needs no Node.js or build step.

**Updating an existing unpacked installation:** replace the files in the **same folder Chrome already loads**, then click **Reload** on its extension card. Keep the extension installed and keep its folder path: this preserves its ID and local website rules. Reloading clears temporary tab activations and exceptions. Do not uninstall it to update.

The interface follows Chrome's UI language: German for German UI languages and English otherwise. Existing German runtime messages are displayed through the current translation catalog. The toolbar uses the compact metallic **Eisenwächter** mask: neutral eyes when inactive and red eyes while keep-alive can run. Normal active operation also shows **On** in English or **An** in German. **!** takes priority for warnings, including paused authentication; disabled tabs have no badge.

## Use a tab or remember a website

Open a website, sign in and click the extension. Switch on **Keep-alive for this tab**. Under **Interval & URL**, choose 1–60 minutes and click **Apply settings**. **Test now** runs an action immediately. The popup shows its method, actual cadence, recent results and next scheduled attempt.

A temporary tab activation ends when the tab closes, navigates to another origin, or Chrome restarts. Same-origin navigation is supported. Chrome-internal pages, the Chrome Web Store and other restricted pages cannot be activated.

Choose **Remember this website** to save its origin, interval and optional URL. Chrome asks for access to that website. Rules apply to all paths of the exact origin (scheme, host and port); subdomains are separate. They resume for matching restored or subsequently opened tabs. The extension does not open tabs itself. Unloaded, discarded or frozen documents wait until Chrome can execute them.

The gear opens website-rule management. You can edit, disable or delete rules. A tab can be switched off despite a rule; that exception lasts until the tab closes or Chrome restarts. If Chrome's website permission is revoked, the rule stays saved but pauses until access is explicitly granted again.

## Automatic application profiles

Leave **Keep-alive URL empty** to use automatic detection. A custom same-origin URL always selects a regular GET request instead, including on a recognized application.

| Profile | Action | Maximum interval |
| --- | --- | --- |
| Generic website | Same-origin GET of the current URL without its fragment | Configured interval |
| BeyondTrust web console | Neutral, non-bubbling `mousemove` directly on the page's window | 1 minute |
| Apache Guacamole | The page's native authenticated `request()` to `api/session/tunnels` | 5 minutes |
| Proxmox VE | Native ticket POST followed by the workspace's `updateLoginData()` | 15 minutes |
| RDP Secure Access | Check the loaded portal state only; no additional requests | 3 minutes |

The actual interval is the smaller of your configured interval and the profile maximum. Your saved setting remains unchanged. Recognition requires known page fingerprints and native capabilities; branding alone is insufficient. Recognized applications wait while initializing or pause when authentication or required APIs are unsupported; they do not silently fetch their static shell.

**BeyondTrust:** the supported `/console` profile waits during application bootstrap and requires an authenticated header before sending activity. A login view pauses it. The signal targets the window, not a remote-control canvas; it sends no click or key press. A prior inspection of one signed-in product version observed its existing activity callback running. This did not establish the cause of an earlier logout or verify hours of production session lifetime.

**Guacamole:** a read-only authenticated native session request extends the server-side idle session. The extension deliberately avoids token-rotation methods: those can overwrite a newer login when an older request finishes. It does not change the page’s token or authentication state. Anonymous and signed-out sessions are excluded. No username, token or tunnel response is returned to the extension worker.

**Proxmox VE:** only an existing normal web-session ticket is supported. A late response is discarded if the page has logged out, changed accounts, replaced its ticket or switched profiles. API-token authentication, incomplete TFA, signed-out sessions and missing workspace capabilities are excluded. The native workspace applies the returned ticket and CSRF state. The extension does not start a fresh login.

**RDP Secure Access:** this profile only monitors the already loaded portal using known Web Protection Technology 1.27o page markers. It sends no additional GET/HEAD requests, does not reload the page and invokes no input or native API. Its scheduled check interval is capped at three minutes; the portal’s observed own 200-second refresh remains unchanged. A recognized login form or an unknown portal state pauses monitoring. This does not renew a session. A custom keep-alive URL still takes priority: it bypasses monitoring and sends regular GET requests, which can reintroduce additional parallel portal requests.

Page inspection observed authenticated portal markers, a later login page returned with HTTP 200, and concurrent responses issuing different new session cookies. Extra full-portal requests could interfere with that behavior; monitoring avoids this additional extension traffic. This does not prove that logouts will be prevented. The cause of reported logouts after two to five hours remains unconfirmed. Connection-duration or scheduled-disconnection policies do not establish browser-login lifetime. Fixed server-side authentication limits remain effective.

The profile was checked live on a signed-out page; authenticated, signed-out and indeterminate states plus the absence of extra requests are covered by local fixtures. There has been no multi-hour live retention test.

Guacamole and Proxmox adapters were checked with source-backed local test doubles, **not live installations**. Upstream references are pinned: [Guacamole authentication service](https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/frontend/src/app/auth/service/authenticationService.js), [Guacamole session access](https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/java/org/apache/guacamole/rest/session/SessionResource.java), [Guacamole page structure](https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/frontend/src/index.html), [Proxmox workspace renewal](https://github.com/proxmox/pve-manager/blob/c79d601b09c00f1b7a7d0ef7ec0fc9326038298e/www/manager6/Workspace.js), [Proxmox authentication helpers](https://github.com/proxmox/proxmox-widget-toolkit/blob/d353f9466dee3e6c35a8af26e83899a6a580169c/src/Utils.js).

## Results and limits

A successful request confirms an HTTP operation. An activity result confirms local dispatch; a renewal result confirms completion of the selected native method. None guarantees that you will remain signed in for hours. The website still controls absolute expiry, required authentication and MFA. Expired or browser-deleted sessions may require signing in again. Cookie sessions may be shared between tabs.

HTTP 401/403, redirects, native authentication failures, and a visible login form or an unknown portal state in the RDP Secure Access profile pause the tab. Sign in or inspect the website, then choose **Resume**. Network failures retry on the regular schedule. Actions have a 15-second timeout; Chrome can delay execution. An unresolved native operation retains a page-local lock, so later attempts wait instead of creating parallel renewals.

Chrome must be running and the computer awake. Alarms may be delayed. Preventing automatic tab discard does not prevent all freezing. The extension has no server-side control over session policy.

## Privacy and permissions

There is no extension backend, telemetry or transfer to an extension provider. HTTP and native renewal requests go to the selected page's own origin. Native authentication data stays in the page's own application context and its normal requests; it is not returned to the extension worker or saved in extension settings, history or logs. Stored state consists of website rules and bounded execution metadata.

- `activeTab` and `scripting`: execute the selected action following deliberate activation.
- `storage`: local website rules and browser-session tab state.
- `alarms`: schedule actions while the extension worker sleeps.
- Optional HTTP(S) website access: requested when you remember that website. Chrome's host grant can be broader than one port; the extension additionally matches exact origins.

The transparent inactive/active Eisenwächter icons and their source details are in [`icons/`](../icons/). Their broad face and short horns keep the red eyes visible at toolbar sizes. They are local assets and require no image service at runtime.

## Development and verification

From the extension directory, use Node.js 20 or newer:

```sh
npm install
npm test
npx playwright install chromium
npm run test:browser
# Focused local profiles:
npm run test:browser:bt
npm run test:browser:profiles
npm run package
```

Tests use dummy credentials, local HTTP fixtures and disposable Chromium profiles. They cover the idle-timeout/control distinction, real isolated-to-main-page event dispatch, Guacamole idle access without auth mutation, Proxmox native auth-state updates, pending logout/account-switch protection, unsupported auth, absence of exported auth data, no remote input, timeout/concurrency, genuine worker wake and full browser restarts. English, German and unsupported-language fallback have a unit matrix; locale screenshots use a test-only Chrome catalog simulation when macOS ignores Chromium's language flags. User Chrome language is not changed.

The full smoke suite grants only loopback host access in a temporary copy. A separate production-manifest run verifies real toolbar activation and `activeTab` without this grant. Native optional-permission acceptance, OS sleep and live Guacamole/Proxmox compatibility remain manual checks. Screenshots go outside the repository to the OS temporary directory.

Packaging writes `tab-session-keeper.zip` and `tab-session-keeper-1.2.2.zip` in the extension directory's parent. ZIPs include only production files, both language catalogs, icons and documentation; development dependencies and tests are excluded.
