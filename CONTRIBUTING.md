# Contributing

Contributions use the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Sign off every commit with `git commit -s`; the commit message must include:

```text
Signed-off-by: Your Name <you@example.com>
```

By signing off, you certify that you have the right to submit the work under
its license. Pull requests with an unsigned commit cannot be merged.

Probe cleanup covers children while the probe is alive; after `kill -9` or an
abrupt probe exit, orphan recovery belongs to the operating system's init.
