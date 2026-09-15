# Persist cookies and storage

The `domjet` package supports named profiles and pluggable
persistence. A profile keeps browser state associated with a stable identity.

## Local persistence

```ts
import createBrowser from "domjet";
import { local } from "domjet/storage";

const browser = await createBrowser({
  profile: "customer-123",
  persistence: local({ directory: "/var/lib/my-app/profiles" }),
});

const page = await browser.newPage();
await page.goto("https://example.com");
await browser.close();
```

The next browser instance using the same profile and directory restores the
saved state. Call `context.backup()` for an explicit checkpoint; automatic
debounced checkpoints are enabled by default.

## Object storage

Use the S3-compatible persistence adapter when profiles need to be shared
between processes or hosts:

```ts
import createBrowser from "domjet";
import s3 from "domjet/s3";

const browser = await createBrowser({
  profile: "customer-123",
  persistence: s3({
    endpoint: "https://objects.example.com",
    bucket: "browser-profiles",
    region: "us-east-1",
  }),
});
```

Use separate profile names for isolated identities. `close({ persist: "skip" })`
is available when a deliberate force-close must not write a checkpoint.
