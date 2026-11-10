# Tab Session Keeper

A Chrome extension that helps keep selected tabs signed in through background activity, without reloading pages or clearing forms.

[Download the latest release](https://github.com/thors-github/tab-session-keeper-chrome-extension/releases/latest) · [Technical guide](docs/TECHNICAL.md) · [Deutsche Anleitung](README.de.md)

## Features

- Enable keep-alive per tab, or remember websites across Chrome restarts.
- Keep-alive profiles for BeyondTrust, Apache Guacamole and Proxmox VE; RDP Secure Access portal monitoring adds no requests.
- English and German UI, with active **On** / **An** badges and red-eyed Eisenwächter icons.
- Local settings; no extension backend or telemetry.

## Install

Requires Chrome 120 or newer. No build step is needed.

1. Download `tab-session-keeper-1.2.2.zip` from the latest release and extract it to a permanent folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked**, select the folder containing `manifest.json`, and pin the extension.

## Update

Replace the files in the **same folder Chrome already loads**, then click **Reload** on the extension card. Keep the extension installed and its folder path unchanged to preserve its ID and saved website rules. Temporary tab selections reset on reload.

## Use

1. Sign in to a website, open the extension, and enable **Keep-alive for this tab**.
2. Set an interval under **Interval & URL**, or use **Test now** to check an action immediately.
3. Choose **Remember this website** to enable matching open tabs automatically after a restart.

Chrome must be running and the computer awake. The website controls session expiry, reauthentication and MFA; this extension cannot guarantee indefinite login. RDP Secure Access only monitors the loaded portal and leaves its own refresh unchanged; monitoring cannot guarantee that logouts stop. See the [technical guide](docs/TECHNICAL.md) for profile support, permissions and test coverage.

## Development

With Node.js 20 or newer:

```sh
npm ci
npm test
```

Browser tests and packaging instructions are in the [technical guide](docs/TECHNICAL.md#development-and-verification).
