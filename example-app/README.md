# Example app

A Capacitor app with `capacitor-background-upload` installed from the repository (`file:..`). It takes its commands from
`test-server.mjs`, so a run on a phone can be driven from a computer:

```bash
node test-server.mjs 8099                       # on the computer
npm install && VITE_CONTROL_URL=http://<computer>:8099 npm run build && npx cap sync
```

On Android with the phone on USB, `adb reverse tcp:8099 tcp:8099` and the default control URL (`http://127.0.0.1:8099`)
do. On an iPhone use the computer's address on the Wi-Fi and answer the local network prompt with Allow.

Then queue commands:

```bash
# a 4 MB file of random bytes, uploaded to the server at 200 kB/s so that it is still running when the app is put away
curl -d '{"action":"upload","megabytes":4,"serverUrl":"http://127.0.0.1:8099/upload?rate=200000"}' http://127.0.0.1:8099/control
```

The app makes the file, logs its SHA-256, starts the upload and reports every event to the server. The server logs each
second of the upload as it arrives and, at the end, the SHA-256 of what it received, which is the check that the bytes
arrived intact.

The app allows cleartext HTTP (`usesCleartextTraffic`, `NSAllowsArbitraryLoads`) only because the test server is plain
HTTP; an app talking to S3 needs neither.
